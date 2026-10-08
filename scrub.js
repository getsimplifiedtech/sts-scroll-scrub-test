/*
 * STS scroll-scrub spike. Measurement build, not a production standard.
 *
 * Architecture (see the merged STS standard):
 *  - Static-first: the HTML/CSS section is complete without this file.
 *  - Capability checks pass -> <html class="js-scrub"> is added.
 *  - Native sticky stage inside a tall track. No GSAP, no Lenis.
 *  - ONE requestAnimationFrame loop, started by scroll/resize, stopped when idle.
 *  - Compressed frames are held as Blobs; only a sliding window is decoded.
 *  - Tiers: 1 full canvas sequence, 2 smaller sequence, 3 still crossfade, 4 static.
 *
 * URL parameters (all tunable, none are standards):
 *  ?frames=60|90|120   frame set          (default 60)
 *  ?tier=1|2|3|4       force a tier       (default: auto)
 *  ?win=12             decoded half-window (frames each side of current)
 *  ?lerp=0.14          per-60Hz-frame easing factor
 *  ?track=300          track height in svh
 *  ?autodrop=0         disable automatic tier drop on low fps
 *  ?hud=0              hide the diagnostics readout
 */
(function () {
  'use strict';

  var Q = new URLSearchParams(location.search);
  var num = function (k, d, lo, hi) {
    var v = parseFloat(Q.get(k));
    if (!isFinite(v)) return d;
    return Math.min(hi, Math.max(lo, v));
  };

  var FRAME_SET = [60, 90, 120].indexOf(parseInt(Q.get('frames'), 10)) >= 0 ? parseInt(Q.get('frames'), 10) : 60;
  var HALF_WIN = Math.round(num('win', 12, 2, 60));
  var LERP = num('lerp', 0.14, 0.02, 1);
  var TRACK = num('track', 300, 120, 800);
  var AUTODROP = Q.get('autodrop') !== '0';
  var FORCE_TIER = parseInt(Q.get('tier'), 10);
  var SHOW_HUD = Q.get('hud') !== '0';
  var DPR_CAP = 1.5;
  var LOAD_CONCURRENCY = 4;
  var FIRST_FRAME_TIMEOUT = 8000;

  var root = document.documentElement;
  var section = document.getElementById('scrub');
  var track = section.querySelector('.scrub__track');
  var stage = section.querySelector('.scrub__stage');
  var canvas = section.querySelector('.scrub__canvas');
  var stillsEl = section.querySelector('.scrub__stills');
  var beats = Array.prototype.slice.call(section.querySelectorAll('.beat'));
  var hud = document.getElementById('hud');
  var ctx = null;

  var manifest = null;
  var tier = 4;
  var setKey = String(FRAME_SET);
  var setInfo = null;
  var N = FRAME_SET;

  var blobs = [];
  var bitmaps = {};
  var pending = {};
  var loading = {};
  var failed = {};
  var bytesLoaded = 0;
  var loadedCount = 0;
  var loadAbort = null;

  var target = 0, current = 0;
  var shown = -1;
  var progress = 0;
  var running = false, visible = true, lastT = 0;
  var activeDtSum = 0, activeTicks = 0, fpsEMA = 0, lowFpsStrikes = 0;
  var dropNotes = [];
  var dirty = true;
  var loaderPhase = 'sparse';
  var destroyed = false;
  var gen = 0;

  function pad(i) { return ('00' + i).slice(-3); }
  function url(key, i) { return 'frames/' + key + '/' + pad(i) + '.webp'; }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function mb(b) { return (b / 1048576).toFixed(2) + ' MB'; }
  function prefersReduced() {
    return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function capabilityCheck() {
    var why = [];
    if (prefersReduced()) why.push('reduced-motion');
    var conn = navigator.connection || {};
    if (conn.saveData) why.push('save-data');
    if (!('IntersectionObserver' in window)) why.push('no-IntersectionObserver');
    if (!window.createImageBitmap) why.push('no-createImageBitmap');
    if (!window.fetch) why.push('no-fetch');
    var c = document.createElement('canvas');
    if (!(c.getContext && c.getContext('2d'))) why.push('no-canvas2d');
    return why;
  }

  function autoTier() {
    var conn = navigator.connection || {};
    var slow = /(^|-)2g$/.test(conn.effectiveType || '') || conn.effectiveType === '3g';
    var lowMem = navigator.deviceMemory && navigator.deviceMemory <= 2;
    if (slow || lowMem) return 3;
    var small = Math.min(screen.width, screen.height) <= 820 && matchMedia('(pointer: coarse)').matches;
    return small ? 2 : 1;
  }

  function setTier(t, note) {
    if (note) dropNotes.push(note);
    tier = t;
    section.setAttribute('data-tier', String(t));
    if (t === 4) {
      stopSequence();
      root.classList.remove('js-scrub');
      section.removeAttribute('data-ready');
      hudUpdate(true);
      return;
    }
    root.classList.add('js-scrub');
    if (t === 3) {
      stopSequence();
      mountStills();
      section.setAttribute('data-ready', '1');
      dirty = true; kick();
      return;
    }
    section.removeAttribute('data-ready');
    startSequence(t === 2 ? FRAME_SET + '-m' : String(FRAME_SET));
  }

  function degrade(reason) {
    if (!AUTODROP || FORCE_TIER) return;
    var next = tier === 1 ? 2 : tier === 2 ? 3 : tier === 3 ? 4 : 4;
    if (next === tier) return;
    setTier(next, 'tier ' + tier + ' -> ' + next + ' (' + reason + ')');
  }

  var stillsMounted = false;
  var STILL_COUNT = 5;
  function mountStills() {
    if (stillsMounted) return;
    stillsMounted = true;
    var base = '60-m';
    for (var k = 0; k < STILL_COUNT; k++) {
      var i = Math.round(k * 59 / (STILL_COUNT - 1));
      var img = new Image();
      img.alt = '';
      img.decoding = 'async';
      img.width = 960; img.height = 576;
      img.src = url(base, i);
      stillsEl.appendChild(img);
    }
  }

  function drawStills() {
    var imgs = stillsEl.children;
    var pos = progress * (imgs.length - 1);
    for (var k = 0; k < imgs.length; k++) {
      imgs[k].style.opacity = String(clamp(1 - Math.abs(pos - k), 0, 1));
    }
  }

  function startSequence(key) {
    stopSequence();
    gen++;
    var myGen = gen;
    setKey = key;
    setInfo = manifest[key];
    N = FRAME_SET;
    blobs = new Array(N);
    bitmaps = {}; pending = {}; loading = {}; failed = {};
    bytesLoaded = 0; loadedCount = 0; shown = -1;
    loaderPhase = 'sparse';
    sizeCanvas();

    var t0 = setTimeout(function () {
      if (myGen === gen && !blobs[0]) degrade('first frame timeout');
    }, FIRST_FRAME_TIMEOUT);

    fetchFrame(0, myGen).then(function () {
      clearTimeout(t0);
      if (myGen !== gen) return;
      return decodeFrame(0, myGen);
    }).then(function () {
      if (myGen !== gen) return;
      if (!bitmaps[0] && !blobs[0]) return;
      section.setAttribute('data-ready', '1');
      pump(myGen);
      dirty = true; kick();
    }).catch(function () {
      if (myGen === gen) degrade('first frame failed');
    });
  }

  function stopSequence() {
    gen++;
    Object.keys(bitmaps).forEach(function (k) { try { bitmaps[k].close(); } catch (e) {} });
    bitmaps = {}; pending = {}; loading = {}; failed = {};
    blobs = [];
  }

  function fetchFrame(i, myGen) {
    if (blobs[i] || loading[i] || failed[i]) return Promise.resolve();
    loading[i] = true;
    return fetch(url(setKey, i)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (b) {
      delete loading[i];
      if (myGen !== gen) return;
      blobs[i] = b;
      bytesLoaded += b.size;
      loadedCount++;
    }, function (e) {
      delete loading[i];
      if (myGen === gen) failed[i] = true;
      throw e;
    });
  }

  var inflight = 0;
  function nextToLoad() {
    var stride = Math.max(4, Math.round(N / 10));
    if (loaderPhase === 'sparse') {
      for (var i = 0; i < N; i += stride) if (!blobs[i] && !loading[i] && !failed[i]) return i;
      if (!blobs[N - 1] && !loading[N - 1] && !failed[N - 1]) return N - 1;
      loaderPhase = 'fill';
    }
    var c = Math.round(current);
    for (var d = 0; d < N; d++) {
      var a = c + d, b = c - d;
      if (a < N && !blobs[a] && !loading[a] && !failed[a]) return a;
      if (b >= 0 && !blobs[b] && !loading[b] && !failed[b]) return b;
    }
    return -1;
  }

  function pump(myGen) {
    if (myGen !== gen) return;
    while (inflight < LOAD_CONCURRENCY) {
      var i = nextToLoad();
      if (i < 0) break;
      inflight++;
      (function (idx) {
        fetchFrame(idx, myGen).then(function () {
          inflight--;
          if (myGen === gen) { dirty = true; kick(); pump(myGen); }
        }, function () {
          inflight--;
          if (myGen === gen) pump(myGen);
        });
      })(i);
    }
  }

  function decodeFrame(i, myGen) {
    if (bitmaps[i] || pending[i] || !blobs[i]) return Promise.resolve();
    pending[i] = true;
    return createImageBitmap(blobs[i]).then(function (bm) {
      delete pending[i];
      if (myGen !== gen || Math.abs(i - Math.round(current)) > HALF_WIN) { bm.close(); return; }
      bitmaps[i] = bm;
      dirty = true; kick();
    }, function () { delete pending[i]; });
  }

  function maintainWindow() {
    var c = Math.round(current);
    var lo = Math.max(0, c - HALF_WIN), hi = Math.min(N - 1, c + HALF_WIN);
    Object.keys(bitmaps).forEach(function (k) {
      var idx = +k;
      if (idx < lo || idx > hi) { try { bitmaps[idx].close(); } catch (e) {} delete bitmaps[idx]; }
    });
    for (var d = 0; d <= HALF_WIN; d++) {
      if (c + d <= hi) decodeFrame(c + d, gen);
      if (d && c - d >= lo) decodeFrame(c - d, gen);
    }
  }

  function releaseDecoded() {
    Object.keys(bitmaps).forEach(function (k) { try { bitmaps[k].close(); } catch (e) {} });
    bitmaps = {}; pending = {}; shown = -1;
  }

  var cw = 0, ch = 0;
  function sizeCanvas() {
    if (tier === 3 || tier === 4) return;
    var r = canvas.getBoundingClientRect();
    var dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    var w = Math.max(2, Math.round(r.width * dpr));
    var h = Math.max(2, Math.round(r.height * dpr));
    var maxW = setInfo ? setInfo.w : 1280;
    if (w > maxW * 1.5) { h = Math.round(h * (maxW * 1.5) / w); w = Math.round(maxW * 1.5); }
    if (w !== cw || h !== ch) {
      cw = w; ch = h;
      canvas.width = w; canvas.height = h;
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';
      shown = -1;
    }
  }

  function nearestBitmap(i) {
    if (bitmaps[i]) return i;
    for (var d = 1; d <= HALF_WIN; d++) {
      if (bitmaps[i + d]) return i + d;
      if (bitmaps[i - d]) return i - d;
    }
    return -1;
  }

  function drawSequence() {
    var want = clamp(Math.round(current), 0, N - 1);
    var use = nearestBitmap(want);
    if (use < 0 || !ctx) return;
    if (use === shown) return;
    ctx.drawImage(bitmaps[use], 0, 0, cw, ch);
    shown = use;
  }

  function readProgress() {
    var r = track.getBoundingClientRect();
    var vh = stage.clientHeight || window.innerHeight;
    var range = Math.max(1, r.height - vh);
    progress = clamp(-r.top / range, 0, 1);
    target = progress * (N - 1);
  }

  function updateBeats() {
    var n = beats.length;
    for (var k = 0; k < n; k++) {
      var a = k / n, b = (k + 1) / n, f = 0.06;
      var o;
      if (k === 0) o = progress < b - f ? 1 : clamp((b - progress) / f, 0, 1);
      else if (k === n - 1) o = clamp((progress - a) / f, 0, 1);
      else o = clamp((progress - a) / f, 0, 1) * clamp((b - progress) / f, 0, 1);
      var el = beats[k];
      el.style.opacity = o.toFixed(3);
      el.style.transform = 'translateY(' + ((1 - o) * 14).toFixed(1) + 'px)';
      el.classList.toggle('is-on', o > 0.5);
    }
  }

  function tick(t) {
    running = false;
    if (destroyed || !visible) { hudUpdate(); return; }
    var dt = lastT ? Math.min(t - lastT, 100) : 16.7;
    lastT = t;
    readProgress();

    var diff = target - current;
    var moving = Math.abs(diff) > 0.01;
    if (moving) {
      var k = 1 - Math.pow(1 - LERP, dt / 16.7);
      current += diff * k;
      if (Math.abs(target - current) < 0.01) current = target;
      activeDtSum += dt; activeTicks++;
      fpsEMA = fpsEMA ? fpsEMA * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
      if (activeTicks >= 45) {
        var meanDt = activeDtSum / activeTicks;
        if (meanDt > 40) { if (++lowFpsStrikes >= 2) { lowFpsStrikes = 0; degrade('avg ' + (1000 / meanDt).toFixed(0) + ' fps'); } }
        else lowFpsStrikes = 0;
        activeDtSum = 0; activeTicks = 0;
      }
    }

    if (tier === 1 || tier === 2) {
      maintainWindow();
      drawSequence();
      if (loadedCount < N) pump(gen);
    } else if (tier === 3) {
      drawStills();
    }
    updateBeats();
    hudUpdate();

    if (moving || dirty) { dirty = false; kick(true); }
    else lastT = 0;
  }

  function kick(fromTick) {
    if (running || destroyed) return;
    running = true;
    requestAnimationFrame(tick);
  }

  var hudT = 0;
  function hudUpdate(force) {
    if (!SHOW_HUD) return;
    var now = performance.now();
    if (!force && now - hudT < 120) return;
    hudT = now;
    var held = Object.keys(bitmaps).length;
    var w = setInfo ? setInfo.w : 1280, h = setInfo ? setInfo.h : 768;
    var tierName = { 1: 'full sequence', 2: 'small sequence', 3: 'still crossfade', 4: 'static' }[tier];
    var total = setInfo ? setInfo.bytes : 0;
    var lines = [
      'frame set        <b>' + FRAME_SET + (tier === 2 ? ' (960x576)' : tier === 1 ? ' (1280x768)' : '') + '</b>',
      'current frame    <b>' + clamp(Math.round(current), 0, N - 1) + '</b> / ' + (N - 1) + (shown >= 0 && shown !== Math.round(current) ? '  (drawing ' + shown + ')' : ''),
      'target frame     <b>' + target.toFixed(1) + '</b>',
      'progress         <b>' + (progress * 100).toFixed(1) + '%</b>   track ' + TRACK + 'svh',
      'rAF fps (active) <b>' + (fpsEMA ? fpsEMA.toFixed(0) : 'idle') + '</b>',
      'decoded held     <b>' + held + '</b>  (window +/-' + HALF_WIN + ')',
      'decoded mem est  <b>' + mb(held * w * h * 4) + '</b>',
      'transfer         <b>' + mb(bytesLoaded) + '</b> / ' + mb(total) + '  (' + loadedCount + '/' + N + ' frames)',
      'tier             <b>' + tier + ' ' + tierName + '</b>' + (FORCE_TIER ? ' (forced)' : ''),
      'lerp ' + LERP + '  dpr cap ' + DPR_CAP + '  dpr ' + (window.devicePixelRatio || 1)
    ];
    if (dropNotes.length) lines.push('<span class="warn">' + dropNotes.join('\n') + '</span>');
    hud.innerHTML = lines.join('\n');
    hud.hidden = false;
  }

  function onScrollOrResize() { dirty = true; kick(); }

  function onResize() {
    if (tier === 1 || tier === 2) sizeCanvas();
    dirty = true; kick();
  }

  function start() {
    track.style.setProperty('--track', TRACK);
    section.style.setProperty('--track', TRACK);

    var why = capabilityCheck();
    if (why.length) {
      dropNotes.push('static: ' + why.join(', '));
      setTier(4);
      return;
    }

    fetch('frames/manifest.json').then(function (r) { return r.json(); }).then(function (m) {
      manifest = m;
      var t = FORCE_TIER >= 1 && FORCE_TIER <= 4 ? FORCE_TIER : autoTier();
      setTier(t);
      window.addEventListener('scroll', onScrollOrResize, { passive: true });
      window.addEventListener('resize', onResize);
      window.addEventListener('orientationchange', onResize);
      window.addEventListener('pageshow', function (e) { if (e.persisted) { dirty = true; kick(); } });

      var io = new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        if (visible) { dirty = true; kick(); }
        else if (tier === 1 || tier === 2) { releaseDecoded(); }
      }, { rootMargin: '50% 0px 50% 0px' });
      io.observe(section);

      document.addEventListener('visibilitychange', function () { if (!document.hidden) { dirty = true; kick(); } });
      readProgress(); current = target; dirty = true; kick();
    }).catch(function () {
      dropNotes.push('manifest failed');
      setTier(4);
    });
  }

  window.__scrub = {
    state: function () {
      return {
        tier: tier, setKey: setKey, N: N, current: current, target: target, shown: shown,
        decoded: Object.keys(bitmaps).length, loaded: loadedCount, bytes: bytesLoaded,
        progress: progress, notes: dropNotes.slice()
      };
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
