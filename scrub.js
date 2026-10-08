/*
 * STS Scroll-Scrub Cinematic Experience: reusable engine.
 *
 * Locked architecture (see docs/ENGINE.md):
 *  - Static-first. The section markup is complete and readable with no JS.
 *    `.js-scrub` is added to the section only after capability checks pass.
 *  - Native `position: sticky` stage inside a tall track. No scroll hijacking.
 *    No GSAP / Lenis / any library.
 *  - ONE requestAnimationFrame loop. ONE master progress value (0..1).
 *    Frame, chapters, CSS (--scrub-p), HUD and listeners all read that value.
 *  - Compressed frames are held as Blobs. Only a sliding window is decoded
 *    (ImageBitmap) and evicted with close(). One display canvas.
 *  - Four tiers: 1 full canvas sequence, 2 mobile canvas sequence,
 *    3 few stills crossfaded by scroll, 4 static stacked narrative.
 *
 * Network lifecycle:
 *  - Nothing heavy loads at page start. A proximity IntersectionObserver
 *    starts the sequence when the section nears the viewport.
 *  - Every sequence owns an AbortController. Leaving a tier aborts its
 *    outstanding requests. Aborts are never treated as load failures.
 *
 * Config: see DEFAULTS below. Sources, in order of precedence:
 *    URL overrides (only when `engineering` is true)
 *    > STSScrub.create(section, cfg)
 *    > <script type="application/json" data-scrub-config> inside the section
 *    > DEFAULTS
 * None of the numbers are STS standards; they are starting points.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    frameCount: 90,                 // STS baseline default (first real-device test)
    availableCounts: [90],          // counts ?frames= may select (engineering only)
    sequences: {                    // {n} = frame count, {key} = resolved key, {i} = 3-digit index
      desktop: { key: '{n}',   src: 'frames/{key}/{i}.webp', w: 1280, h: 768 },
      mobile:  { key: '{n}-m', src: 'frames/{key}/{i}.webp', w: 960,  h: 576 }
    },
    manifest: null,                 // optional { "<key>": { bytes, w, h } } for diagnostics
    stills: { count: 5, urls: null },// tier 3: evenly spaced from the mobile sequence, or explicit urls
    track: 300,                     // scroll track height, in svh
    window: 12,                     // decoded half-window (frames each side of current)
    lerp: 0.14,                     // per-60Hz-frame easing of master progress
    dprCap: 1.5,
    loadConcurrency: 4,
    firstFrameTimeout: 8000,        // ms for the first frame's network fetch
    preload: { margin: '0px 0px -1px 0px' }, // IO rootMargin that starts loading; this = once a pixel is visible (edge-touching does not count)
    activeMargin: '50% 0px',        // rAF + decoding run only inside this margin
    beatFade: 0.06,                 // progress span of a chapter fade
    fallback: { auto: true, tier: 0, lowFps: 25, strikes: 2 },
    hud: false,                     // diagnostic readout; keep false in production
    engineering: false              // allow URL overrides + window.__scrub; keep false in production
  };

  var FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]';

  function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
  function merge(base, over) {
    var out = {};
    var k;
    for (k in base) out[k] = isObj(base[k]) ? merge(base[k], {}) : base[k];
    if (!isObj(over)) return out;
    for (k in over) out[k] = isObj(over[k]) && isObj(out[k]) ? merge(out[k], over[k]) : over[k];
    return out;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function pad(i) { return ('00' + i).slice(-3); }
  function mb(b) { return (b / 1048576).toFixed(2) + ' MB'; }

  function readJsonConfig(section) {
    var el = section.querySelector('script[type="application/json"][data-scrub-config]');
    if (!el) return {};
    try { return JSON.parse(el.textContent); } catch (e) {
      if (global.console) console.warn('[STSScrub] invalid data-scrub-config JSON', e);
      return {};
    }
  }

  function applyUrlOverrides(cfg) {
    var Q = new URLSearchParams(location.search);
    var num = function (k, lo, hi) {
      if (!Q.has(k)) return null;
      var v = parseFloat(Q.get(k));
      return isFinite(v) ? clamp(v, lo, hi) : null;
    };
    var n;
    var frames = parseInt(Q.get('frames'), 10);
    if (cfg.availableCounts.indexOf(frames) >= 0) cfg.frameCount = frames;
    if ((n = num('tier', 1, 4)) !== null) cfg.fallback.tier = Math.round(n);
    if ((n = num('win', 2, 60)) !== null) cfg.window = Math.round(n);
    if ((n = num('lerp', 0.02, 1)) !== null) cfg.lerp = n;
    if ((n = num('track', 120, 800)) !== null) cfg.track = n;
    if ((n = num('dpr', 1, 4)) !== null) cfg.dprCap = n;
    if (Q.get('autodrop') === '0') cfg.fallback.auto = false;
    if (Q.get('hud') === '0') cfg.hud = false;
    if (Q.get('hud') === '1') cfg.hud = true;
    if (Q.get('margin')) cfg.preload.margin = Q.get('margin');
    return cfg;
  }

  function create(section, userCfg) {
    var cfg = merge(DEFAULTS, merge(readJsonConfig(section), userCfg || {}));
    if (cfg.engineering) applyUrlOverrides(cfg);
    cfg.window = Math.round(cfg.window);

    var track = section.querySelector('.scrub__track');
    var stage = section.querySelector('.scrub__stage');
    var canvas = section.querySelector('.scrub__canvas');
    var stillsEl = section.querySelector('.scrub__stills');
    if (!track || !stage || !canvas || !stillsEl) {
      if (global.console) console.warn('[STSScrub] section is missing track/stage/canvas/stills; staying static');
      return null;
    }
    var beats = Array.prototype.slice.call(section.querySelectorAll('.scrub__beat')).map(function (el) {
      return { el: el, on: null, focusables: Array.prototype.slice.call(el.querySelectorAll(FOCUSABLE)) };
    });

    var N = cfg.frameCount;
    var ctx = null, cw = 0, ch = 0;
    var tier = 4;
    var seq = null;             // current sequence (replaced on every tier change)
    var stills = null;          // tier 3 <img> list
    var manifest = null;
    var loadStarted = false, near = false, active = false;
    var ready = false;          // first frame has been painted for the current mode
    var destroyed = false;
    var shown = -1;
    var pTarget = 0, p = 0;     // raw scroll progress, master (smoothed) progress
    var running = false, dirty = true, lastT = 0;
    var activeDtSum = 0, activeTicks = 0, fpsEMA = 0, lowFpsStrikes = 0;
    var notes = [];
    var reqStarted = 0, reqAborted = 0, reqFailed = 0;
    var listeners = {};
    var cleanups = [];
    var hud = null, hudT = 0;

    /* ---------- helpers ---------- */

    function curFrame() { return clamp(Math.round(p * (N - 1)), 0, N - 1); }
    function emit(name, detail, quiet) {
      var list = listeners[name];
      if (list) list.slice().forEach(function (fn) { try { fn(detail); } catch (e) {} });
      if (quiet) return;   // high-frequency events reach subscribers only, not the DOM
      try { section.dispatchEvent(new CustomEvent('sts-scrub:' + name, { bubbles: true, detail: detail })); } catch (e) {}
    }
    function on(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
    function listen(target, type, fn, opts) {
      target.addEventListener(type, fn, opts);
      cleanups.push(function () { target.removeEventListener(type, fn, opts); });
    }
    function resolve(def) {
      var key = def.key.replace('{n}', N);
      return { key: key, src: def.src.replace('{key}', key) };
    }
    function frameUrl(s, i) { return s.src.replace('{i}', pad(i)); }

    function capabilityCheck() {
      var why = [];
      if (global.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) why.push('reduced-motion');
      var conn = navigator.connection || {};
      if (conn.saveData) why.push('save-data');
      if (!('IntersectionObserver' in global)) why.push('no-IntersectionObserver');
      if (!global.createImageBitmap) why.push('no-createImageBitmap');
      if (!global.fetch) why.push('no-fetch');
      if (!global.AbortController) why.push('no-AbortController');
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

    /* ---------- tiers ---------- */

    function setTier(t, note, reason) {
      if (note) notes.push(note);
      var prev = tier;
      tier = t;
      section.setAttribute('data-tier', String(t));
      if (t === 4) {
        stopSequence();
        stopStills();
        resetBeats();
        ready = false;
        section.classList.remove('js-scrub');
        section.removeAttribute('data-ready');
        section.style.removeProperty('--scrub-p');
        section.removeAttribute('data-chapter');
      } else {
        section.classList.add('js-scrub');
        if (t === 3) {
          stopSequence();
          if (loadStarted) mountStills();
          dirty = true; kick();
        } else {
          stopStills();
          if (loadStarted) startSequence(t);
          else { dirty = true; kick(); }
        }
      }
      if (prev !== t) emit('tier', { tier: t, from: prev, reason: reason || note || 'init' });
      hudUpdate(true);
    }

    function degrade(reason) {
      var f = cfg.fallback;
      if (!f.auto || f.tier) return;
      if (tier >= 4) return;
      var next = tier + 1;
      setTier(next, 'tier ' + tier + ' -> ' + next + ' (' + reason + ')', reason);
    }

    /* ---------- proximity-gated loading ---------- */

    function startLoading() {
      if (loadStarted || destroyed || tier === 4) return;
      loadStarted = true;
      emit('near', { margin: cfg.preload.margin });
      fetchManifest();
      if (tier === 3) mountStills(); else startSequence(tier);
    }

    function fetchManifest() {
      if (!cfg.manifest) return;
      fetch(cfg.manifest).then(function (r) { return r.json(); }).then(function (m) {
        manifest = m;
        if (seq) applyManifest(seq);
      }).catch(function () { /* diagnostics metadata only; never fatal */ });
    }
    function applyManifest(s) {
      var info = manifest && manifest[s.key];
      if (!info) return;
      if (info.bytes) s.bytesTotal = info.bytes;
      if (info.w && info.h) { s.w = info.w; s.h = info.h; }
    }

    /* ---------- sequence (tiers 1-2) ---------- */

    function newSequence(t) {
      var def = t === 2 ? cfg.sequences.mobile : cfg.sequences.desktop;
      var r = resolve(def);
      return {
        tier: t, key: r.key, src: r.src, w: def.w, h: def.h, bytesTotal: 0,
        ctrl: new AbortController(), dead: false, timer: 0,
        blobs: new Array(N), bitmaps: {}, pending: {}, loading: {}, failed: {},
        inflight: 0, bytes: 0, count: 0, fails: 0, phase: 'sparse'
      };
    }

    function startSequence(t) {
      stopSequence();
      var s = seq = newSequence(t);
      applyManifest(s);
      shown = -1;
      fitCanvas();
      s.timer = setTimeout(function () {
        if (!s.dead) degrade('first frame timeout');
      }, cfg.firstFrameTimeout);
      fetchFrame(s, curFrame()).then(function (res) {
        clearTimeout(s.timer);
        if (s.dead) return;
        if (res === 'failed') { degrade('first frame failed'); return; }
        dirty = true; kick();
        pump(s);
      });
    }

    // Abort every outstanding request of the abandoned sequence and free its decoded frames.
    function stopSequence() {
      if (!seq) return;
      var s = seq;
      seq = null;
      s.dead = true;
      clearTimeout(s.timer);
      s.ctrl.abort();
      closeAll(s.bitmaps);
      s.bitmaps = {}; s.pending = {}; s.loading = {}; s.blobs = [];
    }

    function closeAll(map) {
      Object.keys(map).forEach(function (k) { try { map[k].close(); } catch (e) {} });
    }

    // Resolves 'ok' | 'aborted' | 'failed'. Never rejects. An abort is not a failure.
    function fetchFrame(s, i) {
      if (s.blobs[i] || s.loading[i] || s.failed[i]) return Promise.resolve('ok');
      s.loading[i] = true;
      reqStarted++;
      return fetch(frameUrl(s, i), { signal: s.ctrl.signal }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.blob();
      }).then(function (b) {
        delete s.loading[i];
        if (s.dead) { reqAborted++; return 'aborted'; }
        s.blobs[i] = b;
        s.bytes += b.size;
        s.count++;
        return 'ok';
      }).catch(function (e) {
        delete s.loading[i];
        if (s.dead || s.ctrl.signal.aborted || (e && e.name === 'AbortError')) { reqAborted++; return 'aborted'; }
        s.failed[i] = true; s.fails++; reqFailed++;
        return 'failed';
      });
    }

    function missing(s, i) { return i >= 0 && i < N && !s.blobs[i] && !s.loading[i] && !s.failed[i]; }
    function nearestMissing(s, c) {
      for (var d = 0; d < N; d++) {
        if (missing(s, c + d)) return c + d;
        if (missing(s, c - d)) return c - d;
      }
      return -1;
    }
    function nextToLoad(s) {
      var c = curFrame(), i;
      // Guarantee the current neighbourhood is covered first, so a fast flick never lands on nothing.
      var span = Math.min(cfg.window, 3), covered = false;
      for (var d = -span; d <= span; d++) if (s.blobs[c + d]) { covered = true; break; }
      if (!covered && (i = nearestMissing(s, c)) >= 0) return i;
      if (s.phase === 'sparse') {
        var stride = Math.max(4, Math.round(N / 10));
        for (i = 0; i < N; i += stride) if (missing(s, i)) return i;
        if (missing(s, N - 1)) return N - 1;
        s.phase = 'fill';
      }
      return nearestMissing(s, c);
    }

    function pump(s) {
      if (s.dead || !near) return;
      while (s.inflight < cfg.loadConcurrency) {
        var i = nextToLoad(s);
        if (i < 0) break;
        s.inflight++;
        fetchFrame(s, i).then(function (res) {
          s.inflight--;
          if (s.dead) return;
          if (res === 'failed') frameFailed(s);
          dirty = true; kick();
          pump(s);
        });
      }
    }

    function frameFailed(s) {
      if (s.fails >= Math.max(3, Math.ceil(N * 0.1))) degrade('frame load errors');
    }

    function decodeFrame(s, i) {
      if (s.bitmaps[i] || s.pending[i] || !s.blobs[i]) return;
      s.pending[i] = true;
      createImageBitmap(s.blobs[i]).then(function (bm) {
        delete s.pending[i];
        if (s.dead || !active || Math.abs(i - curFrame()) > cfg.window) { bm.close(); return; }
        s.bitmaps[i] = bm;
        dirty = true; kick();
      }, function () {
        delete s.pending[i];
        if (s.dead) return;
        s.failed[i] = true; s.fails++; s.blobs[i] = undefined; s.count--;
        frameFailed(s);
      });
    }

    function maintainWindow(s) {
      var c = curFrame();
      var lo = Math.max(0, c - cfg.window), hi = Math.min(N - 1, c + cfg.window);
      Object.keys(s.bitmaps).forEach(function (k) {
        var idx = +k;
        if (idx < lo || idx > hi) { try { s.bitmaps[idx].close(); } catch (e) {} delete s.bitmaps[idx]; }
      });
      for (var d = 0; d <= cfg.window; d++) {
        if (c + d <= hi) decodeFrame(s, c + d);
        if (d && c - d >= lo) decodeFrame(s, c - d);
      }
    }

    // Leaving the section: drop decoded pixels, keep the compressed blobs.
    function releaseDecoded() {
      if (!seq) return;
      closeAll(seq.bitmaps);
      seq.bitmaps = {}; seq.pending = {};
      shown = -1;
    }

    function fitCanvas() {
      if (!seq || tier > 2) return;
      var r = canvas.getBoundingClientRect();
      if (!r.width || !r.height) return;
      var dpr = Math.min(global.devicePixelRatio || 1, cfg.dprCap);
      var w = Math.max(2, Math.round(r.width * dpr));
      var h = Math.max(2, Math.round(r.height * dpr));
      var maxW = seq.w * 1.5;
      if (w > maxW) { h = Math.round(h * maxW / w); w = Math.round(maxW); }
      if (w === cw && h === ch) return;
      var snap = null;
      if (cw && shown >= 0) {            // resizing clears a canvas; carry the last frame across
        snap = document.createElement('canvas');
        snap.width = cw; snap.height = ch;
        snap.getContext('2d').drawImage(canvas, 0, 0);
      }
      cw = w; ch = h;
      canvas.width = w; canvas.height = h;
      ctx = canvas.getContext('2d', { alpha: false });
      ctx.imageSmoothingQuality = 'high';
      if (snap) ctx.drawImage(snap, 0, 0, w, h);
      shown = -1;
    }

    function nearestBitmap(s, i) {
      if (s.bitmaps[i]) return i;
      for (var d = 1; d <= cfg.window; d++) {
        if (s.bitmaps[i + d]) return i + d;
        if (s.bitmaps[i - d]) return i - d;
      }
      return -1;
    }

    // Never clears the canvas: if nothing usable is decoded yet, the last painted frame stays.
    function drawSequence(s) {
      var use = nearestBitmap(s, curFrame());
      if (use < 0 || !ctx || use === shown) return;
      ctx.drawImage(s.bitmaps[use], 0, 0, cw, ch);
      shown = use;
      markReady();
    }

    function markReady() {
      if (ready) return;
      ready = true;
      section.setAttribute('data-ready', '1');
      emit('ready', { tier: tier });
    }

    /* ---------- stills (tier 3) ---------- */

    function stillUrls() {
      if (cfg.stills.urls && cfg.stills.urls.length) return cfg.stills.urls;
      var r = resolve(cfg.sequences.mobile);
      var n = Math.max(2, Math.round(cfg.stills.count));
      var out = [];
      for (var k = 0; k < n; k++) out.push(r.src.replace('{i}', pad(Math.round(k * (N - 1) / (n - 1)))));
      return out;
    }

    function mountStills() {
      if (stills) return;
      stills = stillUrls().map(function (u) {
        var img = new Image();
        img.alt = '';
        img.decoding = 'async';
        img.width = cfg.sequences.mobile.w; img.height = cfg.sequences.mobile.h;
        img.addEventListener('load', function () { if (stills) markReady(); });
        img.src = u;
        stillsEl.appendChild(img);
        return img;
      });
    }

    // Removing src cancels in-flight image loads in current browsers (best effort).
    function stopStills() {
      if (!stills) return;
      stills.forEach(function (img) { img.removeAttribute('src'); });
      stillsEl.textContent = '';
      stills = null;
    }

    // Stacked crossfade: lower stills stay opaque, the next one ramps in. No dim midpoint.
    function drawStills() {
      if (!stills) return;
      var pos = p * (stills.length - 1), base = Math.floor(pos), frac = pos - base;
      for (var k = 0; k < stills.length; k++) {
        stills[k].style.opacity = k <= base ? '1' : k === base + 1 ? frac.toFixed(3) : '0';
      }
    }

    /* ---------- narrative chapters (driven by master progress) ---------- */

    function beatRange(k) {
      var el = beats[k].el, n = beats.length;
      var a = parseFloat(el.getAttribute('data-start'));
      var b = parseFloat(el.getAttribute('data-end'));
      return [isFinite(a) ? a : k / n, isFinite(b) ? b : (k + 1) / n];
    }

    function updateBeats() {
      var n = beats.length, f = cfg.beatFade, chapter = -1, best = 0;
      for (var k = 0; k < n; k++) {
        var r = beatRange(k), a = r[0], b = r[1], o;
        if (k === 0) o = p < b - f ? 1 : clamp((b - p) / f, 0, 1);
        else if (k === n - 1) o = clamp((p - a) / f, 0, 1);
        else o = clamp((p - a) / f, 0, 1) * clamp((b - p) / f, 0, 1);
        var bt = beats[k], el = bt.el;
        el.style.opacity = o.toFixed(3);
        el.style.transform = 'translateY(' + ((1 - o) * 14).toFixed(1) + 'px)';
        var isOn = o > 0.5;
        if (isOn !== bt.on) { bt.on = isOn; el.classList.toggle('is-on', isOn); setFocusable(bt, isOn); }
        if (o > best) { best = o; chapter = k; }
      }
      section.setAttribute('data-chapter', String(chapter));
    }

    // Controls inside an invisible chapter must not be tabbable (a keyboard user would focus an invisible CTA).
    function setFocusable(bt, isOn) {
      bt.focusables.forEach(function (f) {
        if (isOn) {
          if (f.hasAttribute('data-scrub-tab')) {
            var prev = f.getAttribute('data-scrub-tab');
            if (prev === '') f.removeAttribute('tabindex'); else f.setAttribute('tabindex', prev);
            f.removeAttribute('data-scrub-tab');
          }
        } else if (!f.hasAttribute('data-scrub-tab')) {
          f.setAttribute('data-scrub-tab', f.getAttribute('tabindex') || '');
          f.setAttribute('tabindex', '-1');
        }
      });
    }

    function resetBeats() {
      beats.forEach(function (bt) {
        bt.el.style.opacity = ''; bt.el.style.transform = '';
        bt.el.classList.remove('is-on');
        setFocusable(bt, true);
        bt.on = null;
      });
    }

    /* ---------- master progress + the one rAF loop ---------- */

    function readProgress() {
      var r = track.getBoundingClientRect();
      var vh = stage.clientHeight || global.innerHeight;
      pTarget = clamp(-r.top / Math.max(1, r.height - vh), 0, 1);
    }

    function tick(t) {
      running = false;
      if (destroyed || tier === 4) return;
      if (!active) { lastT = 0; hudUpdate(); return; }
      var dt = lastT ? Math.min(t - lastT, 100) : 16.7;
      lastT = t;
      readProgress();

      var span = Math.max(1, N - 1);
      var diff = pTarget - p;
      var moving = Math.abs(diff) * span > 0.01;
      if (moving) {
        p += diff * (1 - Math.pow(1 - cfg.lerp, dt / 16.7));
        if (Math.abs(pTarget - p) * span < 0.01) p = pTarget;
        activeDtSum += dt; activeTicks++;
        fpsEMA = fpsEMA ? fpsEMA * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
        if (activeTicks >= 45) {
          var meanDt = activeDtSum / activeTicks;
          if (meanDt > 1000 / cfg.fallback.lowFps) {
            if (++lowFpsStrikes >= cfg.fallback.strikes) { lowFpsStrikes = 0; degrade('avg ' + (1000 / meanDt).toFixed(0) + ' fps'); }
          } else lowFpsStrikes = 0;
          activeDtSum = 0; activeTicks = 0;
        }
      }
      if (tier === 4) return;   // degrade() may have just gone static

      if (tier <= 2) {
        // Safety net: the section is genuinely on screen but the proximity observer has not fired
        // (e.g. a custom margin larger than the active margin). Never leave a visitor on a poster.
        if (!loadStarted && track.getBoundingClientRect().top < global.innerHeight) { near = true; startLoading(); }
        if (seq) { maintainWindow(seq); drawSequence(seq); pump(seq); }
      } else {
        drawStills();
      }
      updateBeats();
      publish();
      hudUpdate();

      if (moving || dirty) { dirty = false; kick(); }
      else lastT = 0;
    }

    function kick() {
      if (running || destroyed || tier === 4) return;
      running = true;
      requestAnimationFrame(tick);
    }

    // Master progress fan-out: CSS custom property + subscribers. Nothing else owns a timeline.
    var lastPub = -1;
    function publish() {
      if (p === lastPub) return;
      lastPub = p;
      section.style.setProperty('--scrub-p', p.toFixed(4));
      emit('progress', { progress: p, frame: p * (N - 1), chapter: +section.getAttribute('data-chapter') }, true);
    }

    /* ---------- diagnostics ---------- */

    function hudUpdate(force) {
      if (!hud) return;
      var now = performance.now();
      if (!force && now - hudT < 120) return;
      hudT = now;
      var held = seq ? Object.keys(seq.bitmaps).length : 0;
      var w = seq ? seq.w : cfg.sequences.desktop.w, h = seq ? seq.h : cfg.sequences.desktop.h;
      var tierName = { 1: 'full sequence', 2: 'mobile sequence', 3: 'still crossfade', 4: 'static' }[tier];
      var cur = curFrame();
      var lines = [
        'frame set        <b>' + N + (seq ? ' [' + seq.key + '] ' + seq.w + 'x' + seq.h : '') + '</b>',
        'current frame    <b>' + cur + '</b> / ' + (N - 1) + (shown >= 0 && shown !== cur ? '  (drawing ' + shown + ')' : ''),
        'target frame     <b>' + (pTarget * (N - 1)).toFixed(1) + '</b>',
        'progress         <b>' + (p * 100).toFixed(1) + '%</b>  raw ' + (pTarget * 100).toFixed(1) + '%  track ' + cfg.track + 'svh',
        'rAF fps (active) <b>' + (fpsEMA ? fpsEMA.toFixed(0) : 'idle') + '</b>',
        'decoded held     <b>' + held + '</b>  (window +/-' + cfg.window + ')',
        'decoded mem EST  <b>' + mb(held * w * h * 4) + '</b>  (held x w x h x 4, arithmetic, NOT measured)',
        'payload loaded   <b>' + mb(seq ? seq.bytes : 0) + '</b>' + (seq && seq.bytesTotal ? ' / ' + mb(seq.bytesTotal) : '') + '  (' + (seq ? seq.count : 0) + '/' + N + ' frames)',
        'requests         ' + reqStarted + ' started, ' + reqAborted + ' aborted, ' + reqFailed + ' failed',
        'tier             <b>' + tier + ' ' + tierName + '</b>' + (cfg.fallback.tier ? ' (forced)' : '') + (cfg.fallback.auto ? '' : ' (auto-degrade off)'),
        'loading          ' + (loadStarted ? 'started' : 'waiting for proximity (' + cfg.preload.margin + ')') + (near ? ', near' : '') + (active ? ', active' : ''),
        'lerp ' + cfg.lerp + '  dpr cap ' + cfg.dprCap + '  dpr ' + (global.devicePixelRatio || 1)
      ];
      if (notes.length) lines.push('<span class="warn">' + notes.join('\n') + '</span>');
      hud.innerHTML = lines.join('\n');
      hud.hidden = false;
    }

    /* ---------- environment events ---------- */

    function onResize() {
      fitCanvas();
      dirty = true; kick();
    }

    function wire() {
      listen(global, 'scroll', function () { dirty = true; kick(); }, { passive: true });
      listen(global, 'resize', onResize);
      listen(global, 'orientationchange', function () { onResize(); setTimeout(onResize, 300); });
      listen(global, 'pageshow', function (e) {
        if (!e.persisted) return;            // bfcache restore: canvas contents may be gone
        shown = -1; fitCanvas();
        readProgress(); p = pTarget; lastT = 0;
        dirty = true; kick();
      });
      listen(document, 'visibilitychange', function () {
        if (!document.hidden) { lastT = 0; dirty = true; kick(); }
      });
      if (global.ResizeObserver) {
        var ro = new ResizeObserver(onResize);
        ro.observe(stage);
        cleanups.push(function () { ro.disconnect(); });
      }
      if (global.matchMedia) {
        var mq = matchMedia('(prefers-reduced-motion: reduce)');
        var onMq = function (e) { if (e.matches) setTier(4, 'static: reduced-motion', 'reduced-motion'); };
        if (mq.addEventListener) { mq.addEventListener('change', onMq); cleanups.push(function () { mq.removeEventListener('change', onMq); }); }
      }

      // Proximity: begin loading (and keep loading) while within the preload margin.
      var nearIO = new IntersectionObserver(function (es) {
        near = es[es.length - 1].isIntersecting;
        if (near) { startLoading(); if (seq) pump(seq); }
      }, { rootMargin: cfg.preload.margin });
      nearIO.observe(section);
      cleanups.push(function () { nearIO.disconnect(); });

      // Active: run rAF + hold decoded frames only around the viewport.
      var actIO = new IntersectionObserver(function (es) {
        var was = active;
        active = es[es.length - 1].isIntersecting;
        if (active === was) return;
        if (active) {
          readProgress(); p = pTarget; lastT = 0;   // re-entry: snap, don't sweep from a stale position
          dirty = true; kick();
          emit('enter');
        } else {
          releaseDecoded();
          emit('leave');
        }
      }, { rootMargin: cfg.activeMargin });
      actIO.observe(section);
      cleanups.push(function () { actIO.disconnect(); });
    }

    /* ---------- lifecycle ---------- */

    function destroy() {
      destroyed = true;
      stopSequence();
      stopStills();
      resetBeats();
      cleanups.forEach(function (fn) { fn(); });
      cleanups = [];
      section.classList.remove('js-scrub');
      section.setAttribute('data-tier', '4');
      section.removeAttribute('data-ready');
      if (hud && hud.parentNode) hud.parentNode.removeChild(hud);
    }

    function state() {
      return {
        tier: tier, setKey: seq ? seq.key : null, N: N, progress: p, rawProgress: pTarget,
        frame: p * (N - 1), target: pTarget * (N - 1), shown: shown,
        decoded: seq ? Object.keys(seq.bitmaps).length : 0, loaded: seq ? seq.count : 0,
        bytes: seq ? seq.bytes : 0, inflight: seq ? seq.inflight : 0,
        loadStarted: loadStarted, near: near, active: active, ready: ready,
        requests: { started: reqStarted, aborted: reqAborted, failed: reqFailed },
        stills: stills ? stills.length : 0, notes: notes.slice()
      };
    }

    // ---- start ----
    section.style.setProperty('--scrub-track', String(cfg.track));
    if (cfg.hud) {
      hud = document.createElement('aside');
      hud.className = 'scrub__hud';
      hud.setAttribute('aria-hidden', 'true');
      hud.hidden = true;
      document.body.appendChild(hud);
    }

    var why = capabilityCheck();
    if (why.length) {
      notes.push('static: ' + why.join(', '));
      setTier(4, null, why.join(', '));
    } else {
      wire();
      var forced = cfg.fallback.tier >= 1 && cfg.fallback.tier <= 4 ? cfg.fallback.tier : 0;
      setTier(forced || autoTier(), null, 'init');
      readProgress(); p = pTarget;
      dirty = true; kick();
    }

    return { state: state, setTier: function (t) { setTier(t, 'manual -> ' + t, 'manual'); }, on: on, destroy: destroy, config: cfg };
  }

  function initAll() {
    var out = [];
    Array.prototype.forEach.call(document.querySelectorAll('[data-sts-scrub]'), function (el) {
      var inst = create(el);
      if (inst) {
        out.push(inst);
        if (inst.config.engineering && !global.__scrub) global.__scrub = inst;
      }
    });
    return out;
  }

  global.STSScrub = { create: create, initAll: initAll, defaults: DEFAULTS };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initAll);
  else initAll();
})(window);
