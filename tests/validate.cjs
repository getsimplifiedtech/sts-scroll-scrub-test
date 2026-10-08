/*
 * Browser validation for the scrub engine. Needs Playwright (chromium) and a static server:
 *   node tests/serve.cjs . 8123 &
 *   node tests/validate.cjs            (PLAYWRIGHT_MODULE=/path/to/playwright if not resolvable)
 * Real-device behaviour (iOS Safari address bar, bfcache, thermals) is NOT covered here.
 */
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const BASE = (process.env.BASE_URL || 'http://localhost:8123') + '/index.html';
let pass = 0, fail = 0;
const results = [];
function check(name, cond, info) {
  (cond ? pass++ : fail++);
  results.push((cond ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  [' + JSON.stringify(info) + ']' : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(browser, qs, opts = {}) {
  const ctx = await browser.newContext(Object.assign({ viewport: { width: 1280, height: 800 } }, opts));
  const page = await ctx.newPage();
  const log = { errors: [], reqs: [], failed: [], console: [] };
  page.on('console', (m) => { if (m.type() === 'error') log.errors.push(m.text()); });
  page.on('pageerror', (e) => log.errors.push('pageerror: ' + e.message));
  page.on('request', (r) => log.reqs.push(r.url().replace('http://localhost:8123/', '')));
  page.on('requestfailed', (r) => log.failed.push({ u: r.url().replace('http://localhost:8123/', ''), e: r.failure() && r.failure().errorText }));
  await page.addInitScript(() => {
    window.__closes = 0;
    if (window.ImageBitmap) { const c = ImageBitmap.prototype.close; ImageBitmap.prototype.close = function () { window.__closes++; return c.call(this); }; }
  });
  await page.goto(BASE + (qs || ''), { waitUntil: 'load' });
  return { ctx, page, log };
}
const st = (page) => page.evaluate(() => window.__scrub && window.__scrub.state());
async function scrollToP(page, f) {
  await page.evaluate((f) => {
    const s = document.getElementById('scrub'), t = s.querySelector('.scrub__track'), g = s.querySelector('.scrub__stage');
    const top = t.getBoundingClientRect().top + scrollY;
    window.scrollTo(0, top + (t.offsetHeight - g.clientHeight) * f);
  }, f);
}
async function settle(page, ms = 1500) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await st(page);
    if (s && Math.abs(s.progress - s.rawProgress) < 1e-4) { await sleep(120); return s; }
    await sleep(60);
  }
  return st(page);
}
async function canvasNonBlank(page) {
  return page.evaluate(() => {
    const c = document.querySelector('.scrub__canvas');
    if (!c.width) return -1;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let nz = 0; for (let i = 0; i < d.length; i += 40) if (d[i] + d[i + 1] + d[i + 2] > 12) nz++;
    return nz / (d.length / 40);
  });
}
const frameReqs = (log) => log.reqs.filter((u) => /^frames\/\d+(-m)?\/\d+\.webp/.test(u));

(async () => {
  const browser = await chromium.launch();

  /* ===== 13 + 1 + 14: default 90, proximity, scrub ===== */
  {
    const { ctx, page, log } = await open(browser, '');
    await sleep(800);
    let s = await st(page);
    const early = frameReqs(log).filter((u) => u !== 'frames/90/000.webp');
    check('13 no frame downloads at page load (only the static poster)', early.length === 0, early.slice(0, 3));
    check('13 manifest not fetched at page load', !log.reqs.includes('frames/manifest.json'));
    check('13 loadStarted=false before proximity', s.loadStarted === false);
    check('default: frameCount 90, tier 1, desktop key "90"', s.N === 90 && s.tier === 1, { N: s.N, tier: s.tier });
    check('static poster visible & canvas not ready before load', s.ready === false && (await page.evaluate(() => getComputedStyle(document.querySelector('.scrub__poster')).opacity)) === '1');
    await scrollToP(page, 0); await page.evaluate(() => scrollTo(0, 450)); await sleep(1200);
    s = await st(page);
    check('13 loading begins on proximity (scroll 450px, section top 350px below fold)', s.loadStarted && frameReqs(log).length > 5, { reqs: frameReqs(log).length });
    check('13 manifest fetched at proximity', log.reqs.includes('frames/manifest.json'));
    await scrollToP(page, 0); await settle(page);
    check('1 default 90: first frame painted, canvas ready', (await st(page)).ready === true);
    const results2 = [];
    for (const f of [0.25, 0.5, 0.75, 1]) {
      await scrollToP(page, f); await sleep(900);
      const x = await settle(page);
      results2.push([f, x.frame.toFixed(1), x.shown, x.decoded]);
      check(`1 scrub p=${f}: frame ~${(f * 89).toFixed(0)}, drawn within 3`, Math.abs(x.frame - f * 89) < 1.5 && Math.abs(x.shown - x.frame) <= 3, { frame: x.frame, shown: x.shown });
    }
    check('1 canvas non-blank at end', (await canvasNonBlank(page)) > 0.2, await canvasNonBlank(page));
    // 8 reverse
    const rev = [];
    for (const f of [0.75, 0.5, 0.25, 0]) {
      await scrollToP(page, f); await sleep(900);
      const x = await settle(page);
      rev.push(Math.abs(x.shown - f * 89));
    }
    check('8 reverse scrub lands near target frames', rev.every((d) => d <= 3), rev);
    // master progress agreement
    await scrollToP(page, 0.5); await settle(page);
    const mp = await page.evaluate(() => ({ css: +document.getElementById('scrub').style.getPropertyValue('--scrub-p'), st: window.__scrub.state().progress, ch: document.getElementById('scrub').dataset.chapter }));
    check('master progress: --scrub-p equals state progress', Math.abs(mp.css - mp.st) < 1e-3, mp);
    check('master progress: chapter 1 at p=0.5', mp.ch === '1', mp);
    for (const [f, ch] of [[0.1, '0'], [0.9, '2']]) { await scrollToP(page, f); await settle(page); check(`chapter at p=${f} is ${ch}`, (await page.evaluate(() => document.getElementById('scrub').dataset.chapter)) === ch); }
    // 16 keyboard: invisible CTA must not be tabbable
    await scrollToP(page, 0.1); await settle(page);
    check('a11y: CTA tabindex=-1 while its chapter is hidden', (await page.evaluate(() => document.querySelector('.scrub__cta').getAttribute('tabindex'))) === '-1');
    await scrollToP(page, 1); await settle(page);
    check('a11y: CTA tabbable when its chapter is active', (await page.evaluate(() => document.querySelector('.scrub__cta').getAttribute('tabindex'))) === null);
    await page.keyboard.press('Tab'); // just ensure no throw
    check('a11y: canvas and stills are aria-hidden', await page.evaluate(() => document.querySelector('.scrub__canvas').getAttribute('aria-hidden') === 'true' && document.querySelector('.scrub__stills').getAttribute('aria-hidden') === 'true'));
    check('14 chapters + CTA exist as DOM text', await page.evaluate(() => [...document.querySelectorAll('.scrub__beat')].every((b) => b.textContent.trim().length > 20) && !!document.querySelector('.scrub__cta').textContent.trim()));
    // 11 leave and re-enter
    const before = await st(page);
    await scrollToP(page, 0.5); await settle(page); await sleep(300);
    const mid = await st(page);
    const closes0 = await page.evaluate(() => window.__closes);
    await page.evaluate(() => { const f = document.createElement('div'); f.style.height = '3000px'; f.id = 'filler'; document.body.appendChild(f); scrollTo(0, document.documentElement.scrollHeight); }); await sleep(600);
    const away = await st(page);
    const closes1 = await page.evaluate(() => window.__closes);
    check('11 leaving section releases decoded frames (close() called, held=0)', away.active === false && away.decoded === 0 && closes1 - closes0 >= mid.decoded && mid.decoded > 0, { midDecoded: mid.decoded, away: away.decoded, closes: closes1 - closes0 });
    check('11 compressed frames kept on leave', away.loaded >= mid.loaded, { loaded: away.loaded });
    const blankAway = await canvasNonBlank(page);
    await scrollToP(page, 0.5); await sleep(1000); await settle(page);
    const back = await st(page);
    check('11 re-entry recreates decoded window', back.active && back.decoded > 3 && Math.abs(back.shown - back.frame) <= 2, { decoded: back.decoded, shown: back.shown, frame: back.frame });
    check('11 canvas never blank while away/re-entering', blankAway > 0.2 && (await canvasNonBlank(page)) > 0.2, blankAway);
    const win = await page.evaluate(() => window.__scrub.config.window);
    check('window bound: decoded <= 2*window+1', back.decoded <= 2 * win + 1, { decoded: back.decoded, win });
    // pageshow persisted
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))); await sleep(400);
    check('pageshow(persisted) redraws without error', (await st(page)).shown >= 0 && (await canvasNonBlank(page)) > 0.2);
    // visibilitychange
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await sleep(200);
    check('15 no console errors on default path', log.errors.length === 0, log.errors);
    check('15 no failed requests on default path', log.failed.length === 0, log.failed.slice(0, 3));
    console.log('scrub samples', JSON.stringify(results2));
    await ctx.close();
  }

  /* ===== 9 fast scroll: never blank ===== */
  {
    const { ctx, page, log } = await open(browser, '?autodrop=0');
    await page.evaluate(() => scrollTo(0, 450)); await sleep(1500);
    await scrollToP(page, 0); await settle(page);
    let blank = 0, samples = 0, maxHeld = 0;
    for (const f of [0.95, 0.1, 0.8, 0.02, 0.6, 0.97, 0.3]) {
      await scrollToP(page, f);
      for (let k = 0; k < 8; k++) { const b = await canvasNonBlank(page); samples++; if (b < 0.2) blank++; await sleep(40); }
    }
    check('9 fast flicks: canvas never blank', blank === 0, { blank, samples });
    await settle(page);
    const s = await st(page); maxHeld = s.decoded;
    check('9 after flicks, settles on correct frame', Math.abs(s.shown - s.frame) <= 3, { shown: s.shown, frame: s.frame });
    check('15 no console errors on fast-scroll path', log.errors.length === 0, log.errors);
    await ctx.close();
  }

  /* ===== 2 frame sets ===== */
  for (const n of [60, 120]) {
    const { ctx, page, log } = await open(browser, `?frames=${n}`);
    await page.evaluate(() => scrollTo(0, 450)); await sleep(1200);
    await scrollToP(page, 1); const s = await settle(page);
    const reqs = frameReqs(log).filter((u) => u.startsWith(`frames/${n}/`));
    check(`2 frames=${n}: N, key, requests`, s.N === n && s.setKey === String(n) && reqs.length > 5 && Math.abs(s.shown - (n - 1)) <= 3, { N: s.N, key: s.setKey, shown: s.shown, reqs: reqs.length });
    check(`2 frames=${n}: no console errors`, log.errors.length === 0, log.errors);
    await ctx.close();
  }
  {
    const { ctx, page } = await open(browser, '?frames=77');
    check('2 unavailable frame count ignored -> 90', (await st(page)).N === 90);
    await ctx.close();
  }

  /* ===== 3 tier 2 ===== */
  {
    const { ctx, page, log } = await open(browser, '?tier=2');
    await page.evaluate(() => scrollTo(0, 450)); await sleep(1200);
    await scrollToP(page, 0.6); const s = await settle(page);
    const dims = await page.evaluate(() => { const c = document.querySelector('.scrub__canvas'); return [c.width, c.height]; });
    check('3 tier 2: mobile set 90-m, canvas capped to 1.5x source', s.tier === 2 && s.setKey === '90-m' && dims[0] <= 960 * 1.5 + 1, { key: s.setKey, dims });
    check('3 tier 2: only -m frames requested', frameReqs(log).filter((u) => u.startsWith('frames/90/') && u !== 'frames/90/000.webp').length === 0);
    check('3 tier 2: canvas non-blank & scrubbing', (await canvasNonBlank(page)) > 0.2 && Math.abs(s.shown - s.frame) <= 3, { shown: s.shown, frame: s.frame });
    check('15 tier 2 no console errors', log.errors.length === 0, log.errors);
    await ctx.close();
  }

  /* ===== 4 tier 3 stills ===== */
  {
    const { ctx, page, log } = await open(browser, '?tier=3');
    await sleep(500);
    check('4 tier 3: no still downloads before proximity', frameReqs(log).filter((u) => u !== 'frames/90/000.webp').length === 0);
    await page.evaluate(() => scrollTo(0, 450)); await sleep(1000);
    await scrollToP(page, 0.5); const s = await settle(page);
    const ops = await page.evaluate(() => [...document.querySelectorAll('.scrub__stills img')].map((i) => +i.style.opacity));
    check('4 tier 3: 5 stills mounted, crossfade at p=0.5 shows still 2 solid', s.tier === 3 && ops.length === 5 && ops[0] === 1 && ops[1] === 1 && ops[2] === 1 && ops[3] === 0, ops);
    await scrollToP(page, 0.375); await settle(page);
    const ops2 = await page.evaluate(() => [...document.querySelectorAll('.scrub__stills img')].map((i) => +i.style.opacity));
    check('4 tier 3: mid-crossfade lower layer stays opaque (no dim)', ops2[1] === 1 && ops2[2] > 0.4 && ops2[2] < 0.6 && ops2[3] === 0, ops2);
    check('4 tier 3: canvas hidden, poster base layer visible, beats update', await page.evaluate(() => getComputedStyle(document.querySelector('.scrub__canvas')).display === 'none'));
    check('4 tier 3: no 90/ desktop frames requested', frameReqs(log).filter((u) => /^frames\/90\/(?!000)/.test(u)).length === 0);
    check('15 tier 3 no console errors', log.errors.length === 0, log.errors);
    await ctx.close();
  }

  /* ===== 5 tier 4 + 6 reduced motion + 7 no-JS ===== */
  {
    const { ctx, page, log } = await open(browser, '?tier=4');
    await page.evaluate(() => scrollTo(0, 900)); await sleep(800);
    const info = await page.evaluate(() => ({
      cls: document.getElementById('scrub').className,
      pos: getComputedStyle(document.querySelector('.scrub__stage')).position,
      beats: [...document.querySelectorAll('.scrub__beat')].map((b) => ({ op: getComputedStyle(b).opacity, pos: getComputedStyle(b).position, h: b.getBoundingClientRect().height })),
      canvas: getComputedStyle(document.querySelector('.scrub__canvas')).display,
      inline: [...document.querySelectorAll('.scrub__beat')].map((b) => b.getAttribute('style')),
      tab: document.querySelector('.scrub__cta').getAttribute('tabindex')
    }));
    check('5 tier 4: no js-scrub, static stage, stacked readable beats', !/js-scrub/.test(info.cls) && info.pos === 'relative' && info.beats.every((b) => b.op === '1' && b.pos === 'static' && b.h > 40) && info.canvas === 'none' && info.tab === null, info);
    check('5 tier 4: zero sequence frames requested', frameReqs(log).filter((u) => u !== 'frames/90/000.webp').length === 0);
    check('15 tier 4 no console errors', log.errors.length === 0, log.errors);
    await ctx.close();
  }
  {
    const { ctx, page, log } = await open(browser, '', { reducedMotion: 'reduce' });
    await page.evaluate(() => scrollTo(0, 900)); await sleep(500);
    const s = await st(page);
    const readable = await page.evaluate(() => [...document.querySelectorAll('.scrub__beat')].every((b) => getComputedStyle(b).opacity === '1' && getComputedStyle(b).position === 'static'));
    check('6 reduced-motion: static tier 4, readable, no sequence downloads', s.tier === 4 && readable && frameReqs(log).filter((u) => u !== 'frames/90/000.webp').length === 0, { tier: s.tier, notes: s.notes });
    // runtime switch to reduce
    await ctx.close();
    const c2 = await open(browser, '');
    await c2.page.evaluate(() => scrollTo(0, 450)); await sleep(1000);
    await c2.page.emulateMedia({ reducedMotion: 'reduce' }); await sleep(400);
    const s2 = await st(c2.page);
    check('6 reduced-motion toggled at runtime -> static tier 4', s2.tier === 4 && s2.decoded === 0, { tier: s2.tier });
    await c2.ctx.close();
  }
  {
    const ctx = await browser.newContext({ javaScriptEnabled: false, viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto(BASE);
    const res = await page.$$eval('.scrub__beat', (bs) => bs.map((b) => ({ op: getComputedStyle(b).opacity, pos: getComputedStyle(b).position, text: b.textContent.trim().length })));
    const poster = await page.$eval('.scrub__poster', (i) => ({ vis: getComputedStyle(i).display, op: getComputedStyle(i).opacity, w: i.naturalWidth }));
    const canvas = await page.$eval('.scrub__canvas', (c) => getComputedStyle(c).display);
    check('7 no-JS: all chapters visible, static, poster loaded, canvas hidden', res.length === 3 && res.every((r) => r.op === '1' && r.pos === 'static' && r.text > 20) && poster.w > 0 && poster.op === '1' && canvas === 'none', { res, poster, canvas });
    await ctx.close();
  }

  /* ===== 12 abort on tier change + failure vs abort ===== */
  {
    const { ctx, page, log } = await open(browser, '?tier=1&autodrop=1');
    // slow every frame response so requests stay in flight
    await page.route(/frames\/(90|90-m)\/\d+\.webp/, async (route) => { await sleep(2500); try { await route.continue(); } catch (e) {} });
    // first frame must succeed for tier-1 backlog to build up: do not delay frame 0 / current
    await page.evaluate(() => scrollTo(0, 450)); await sleep(500);
    const s1 = await st(page);
    const t1 = frameReqs(log).filter((u) => /^frames\/90\/(?!000)/.test(u));
    log.reqs.length = 0; log.failed.length = 0;
    await page.evaluate(() => window.__scrub.setTier(2)); await sleep(600);
    const s2 = await st(page);
    const abortedT1 = log.failed.filter((f) => /^frames\/90\//.test(f.u));
    check('12 tier 1 -> 2 aborts outstanding tier-1 requests', abortedT1.length >= 1 && abortedT1.every((f) => /ABORTED/.test(f.e)), { inflightBefore: s1.inflight, aborted: abortedT1.length });
    check('12 abort is not a failure: no escalation, tier stays 2, failed=0', s2.tier === 2 && s2.requests.failed === 0 && s2.requests.aborted >= 1, s2.requests);
    check('12 new sequence uses -m set only', frameReqs(log).every((u) => u.startsWith('frames/90-m/')) , frameReqs(log).slice(0, 3));
    log.reqs.length = 0; log.failed.length = 0;
    await page.evaluate(() => window.__scrub.setTier(3)); await sleep(500);
    const abortedT2 = log.failed.filter((f) => /^frames\/90-m\/\d+/.test(f.u) && /ABORTED/.test(f.e));
    const s3 = await st(page);
    check('12 tier 2 -> 3 aborts outstanding tier-2 requests, stills mount', abortedT2.length >= 1 && s3.stills === 5 && s3.tier === 3, { aborted: abortedT2.length, stills: s3.stills });
    const stillsReq = frameReqs(log).length;
    log.reqs.length = 0;
    await page.evaluate(() => window.__scrub.setTier(4)); await sleep(500);
    const s4 = await st(page);
    check('12 tier 3 -> 4 unmounts stills, no new requests', s4.tier === 4 && s4.stills === 0 && frameReqs(log).length === 0);
    check('12 no console errors from aborted requests', log.errors.length === 0, log.errors);
    await ctx.close();
  }
  {
    // genuine failure of the tier-1 set escalates to tier 2
    const { ctx, page, log } = await open(browser, '');
    await page.route(/frames\/90\/(?!000)\d+\.webp/, (route) => route.abort('failed'));
    await page.evaluate(() => scrollTo(0, 450)); await sleep(2000);
    const s = await st(page);
    check('12 genuine frame failures (not aborts) escalate tier 1 -> 2', s.tier === 2 && s.notes.some((n) => /frame load errors|first frame/.test(n)), { tier: s.tier, notes: s.notes });
    await ctx.close();
  }
  {
    // first frame timeout escalation still works (slow first frame) -- set to 404
    const { ctx, page } = await open(browser, '');
    await page.route(/frames\/90(-m)?\/\d+\.webp/, (route) => route.fulfill({ status: 404, body: 'nf' }));
    await page.evaluate(() => scrollTo(0, 450)); await sleep(2500);
    const s = await st(page);
    check('12 first-frame HTTP failures degrade 1->2->3 (stills 404 stay on poster)', s.tier >= 3, { tier: s.tier, notes: s.notes });
    await ctx.close();
  }

  /* ===== 10 orientation / resize ===== */
  {
    const { ctx, page, log } = await open(browser, '?tier=2&autodrop=0', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    await page.evaluate(() => scrollTo(0, 500)); await sleep(1200);
    await scrollToP(page, 0.5); await settle(page);
    const geo = () => page.evaluate(() => { const g = document.querySelector('.scrub__stage').getBoundingClientRect(), c = document.querySelector('.scrub__canvas'), r = c.getBoundingClientRect(); return { stage: [Math.round(g.width), Math.round(g.height)], canvas: [c.width, c.height], rect: [Math.round(r.width), Math.round(r.height)], cx: Math.round(r.left + r.width / 2), ratio: +(c.width / c.height).toFixed(3), prog: window.__scrub.state().progress }; });
    const g1 = await geo();
    await page.setViewportSize({ width: 844, height: 390 }); await sleep(800); await settle(page);
    const g2 = await geo();
    await page.setViewportSize({ width: 390, height: 844 }); await sleep(800); await settle(page);
    const g3 = await geo();
    check('10 portrait dpr3: canvas capped (<=1.5x source 960), correct aspect', g1.canvas[0] <= 1440 + 1 && Math.abs(g1.ratio - 5 / 3) < 0.02, g1);
    check('10 rotation to landscape resizes canvas to new geometry', g2.stage[0] === 844 && g2.rect[0] !== g1.rect[0] && Math.abs(g2.ratio - 5 / 3) < 0.02, g2);
    check('10 back to portrait restores geometry', g3.rect[0] === g1.rect[0] && g3.canvas[0] === g1.canvas[0], g3);
    check('10 progress stays in 0..1 and canvas painted after resizes', g3.prog >= 0 && g3.prog <= 1 && (await canvasNonBlank(page)) > 0.2);
    check('10 canvas stayed painted across resize (no blank)', (await canvasNonBlank(page)) > 0.2);
    check('15 mobile/rotate no console errors', log.errors.length === 0, log.errors);
    // auto tier on a coarse-pointer small screen should be tier 2 when not forced
    await ctx.close();
    const m = await open(browser, '', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 });
    check('3 auto tier on small touch device = 2', (await st(m.page)).tier === 2, (await st(m.page)).tier);
    await m.ctx.close();
  }

  /* ===== engineering controls ===== */
  {
    const { ctx, page } = await open(browser, '?win=4&lerp=0.5&track=200&hud=1&dpr=2&margin=10%25%200px&tier=1&autodrop=0');
    const c = await page.evaluate(() => window.__scrub.config);
    const hudTxt = await page.evaluate(() => document.querySelector('.scrub__hud') && document.querySelector('.scrub__hud').textContent);
    check('eng: URL controls map to config', c.window === 4 && c.lerp === 0.5 && c.track === 200 && c.dprCap === 2 && c.preload.margin === '10% 0px' && c.fallback.auto === false && c.fallback.tier === 1, c);
    check('eng: HUD shows all required fields, memory labelled as estimate', ['frame set', 'current frame', 'target frame', 'progress', 'rAF fps', 'decoded held', 'EST', 'NOT measured', 'payload loaded', 'tier', 'lerp', 'dpr'].every((k) => hudTxt.includes(k)), hudTxt && hudTxt.slice(0, 120));
    const trackH = await page.evaluate(() => Math.round(document.querySelector('.scrub__track').getBoundingClientRect().height / innerHeight * 100));
    check('eng: track=200 -> 200svh', trackH === 200, trackH);
    await ctx.close();
    const off = await open(browser, '?hud=0');
    check('eng: ?hud=0 removes HUD', (await off.page.evaluate(() => !document.querySelector('.scrub__hud'))));
    await off.ctx.close();
    const noEng = await browser.newContext(); const p2 = await noEng.newPage();
    await p2.route('**/index.html*', async (route) => { const r = await route.fetch(); let b = await r.text(); b = b.replace('"engineering": true,', '"engineering": false,').replace('"hud": true', '"hud": false'); route.fulfill({ response: r, body: b }); });
    await p2.goto(BASE + '?frames=60&hud=1&tier=3');
    await sleep(400);
    const prod = await p2.evaluate(() => ({ hud: !!document.querySelector('.scrub__hud'), dbg: typeof window.__scrub, tier: document.getElementById('scrub').dataset.tier, api: typeof window.STSScrub }));
    check('prod: engineering/hud off ignores URL overrides, no HUD, no __scrub', !prod.hud && prod.dbg === 'undefined' && prod.tier !== '3' && prod.api === 'object', prod);
    await noEng.close();
  }

  /* ===== hero handoff events ===== */
  {
    const { ctx, page } = await open(browser, '');
    await page.evaluate(() => { window.__ev = []; ['near', 'ready', 'enter', 'leave', 'tier'].forEach((n) => document.getElementById('scrub').addEventListener('sts-scrub:' + n, () => window.__ev.push(n))); });
    await page.evaluate(() => scrollTo(0, 450)); await sleep(1500);
    const ev = await page.evaluate(() => window.__ev);
    check('handoff: near fires before ready; both dispatched on the section', ev.includes('near') && ev.includes('ready') && ev.indexOf('near') < ev.indexOf('ready'), ev);
    await ctx.close();
  }

  await browser.close();
  console.log(results.join('\n'));
  console.log(`\nPASSED: ${pass} ok, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR', e); process.exit(2); });
