# STS Scroll-Scrub engine (Product #2)

Files: `scrub.js` (engine, no dependencies), `scrub.css` (structure + base theme),
`index.html` (reference section + config), `demo.css` (demo page shell only).

The engine is plain JS. There is no build step and no library.

## Locked architecture (unchanged)

Static-first, native `position: sticky`, one `requestAnimationFrame` loop, one master
progress value, a sliding decoded-frame window, a four-tier fallback. See the top-of-file
comment in `scrub.js`. Nothing here is scroll hijacking, and GSAP/Lenis are not used.

## Using it on another site

1. Author the section markup (poster, chapters, CTA) as normal HTML. See `index.html`.
   Content is never injected by script, so the no-JS / reduced-motion / failed-load
   experience is the markup itself.
2. Put behaviour config in a JSON block inside the section, or call
   `STSScrub.create(sectionEl, cfg)`:

```html
<section class="scrub" data-sts-scrub data-tier="4" aria-labelledby="h">
  <script type="application/json" data-scrub-config>{ "frameCount": 90, ... }</script>
  <div class="scrub__track"><div class="scrub__stage">
    <img class="scrub__poster" ...> <canvas class="scrub__canvas" aria-hidden="true"></canvas>
    <div class="scrub__stills" aria-hidden="true"></div>
    <div class="scrub__copy"> <article class="scrub__beat">...</article> ... </div>
  </div></div>
</section>
```

3. Generate a frame set per sequence (the reference repo does it in `.github/workflows/pages.yml`)
   and point `sequences` at it.

Poster, chapters and CTA are markup, not config, on purpose: content that exists only in
JS config would not survive without JS. Chapter timing can be adjusted per chapter with
`data-start` / `data-end` (0..1) on `.scrub__beat`; the default is equal thirds.

## Config reference

All values are starting points, not STS standards. Defaults live in `DEFAULTS` in `scrub.js`.

| key | default | meaning |
|---|---|---|
| `frameCount` | `90` | frames per sequence. 90 is the STS baseline default; 60 lighter, 120 only where it visibly helps |
| `availableCounts` | `[90]` | counts that `?frames=` may select (engineering only) |
| `sequences.desktop` / `.mobile` | `{n}` / `{n}-m` | `key`, `src` template (`{key}`, `{i}` = 3-digit index), `w`, `h` |
| `manifest` | `null` | optional `{ "<key>": { bytes, w, h } }` for diagnostics; failure is never fatal |
| `stills` | `{ count: 5 }` | tier 3 stills, evenly spaced from the mobile sequence, or `{ urls: [...] }` |
| `track` | `300` | scroll track height in `svh` |
| `window` | `12` | decoded half-window: frames decoded each side of the current frame |
| `lerp` | `0.14` | per-60Hz-frame easing of the master progress |
| `dprCap` | `1.5` | canvas device-pixel-ratio cap |
| `loadConcurrency` | `4` | parallel frame requests |
| `firstFrameTimeout` | `8000` | ms before a stuck first-frame request degrades a tier |
| `preload.margin` | `0px 0px -1px 0px` | IntersectionObserver `rootMargin` that starts loading |
| `activeMargin` | `50% 0px` | rAF + decoding run only inside this margin |
| `beatFade` | `0.06` | progress span of a chapter fade |
| `fallback` | `{ auto: true, tier: 0, lowFps: 25, strikes: 2 }` | auto-degrade on/off, forced tier, fps rule |
| `hud` | `false` | diagnostic readout |
| `engineering` | `false` | allow URL overrides and `window.__scrub` |

Geometry/theme are CSS custom properties on `.scrub` (`--scrub-aspect`, `--scrub-x`,
`--scrub-y`, `--scrub-box-w`, `--scrub-bg`, `--scrub-accent`, ...). `--scrub-track` is set by the engine.

Production: remove `engineering` and `hud` from the config. URL parameters are then ignored,
no HUD is created and `window.__scrub` is not exposed.

## Master progress

`readProgress()` maps the track's position to a raw value 0..1. The loop eases it into the
single master value `p`. Everything reads `p` and nothing else owns a timeline:

- image frame: `round(p * (N - 1))`
- chapters, `data-chapter`, `is-on`, focusability of chapter controls
- tier 3 still crossfade
- CSS: `--scrub-p` on the section (drive typography, CTA state, counters from CSS)
- JS: `scrub.on('progress', ({ progress, frame, chapter }) => ...)`
- HUD

## Loading lifecycle (proximity)

1. Page load: only the static markup and poster. No frame, still or manifest request.
2. A proximity `IntersectionObserver` (`preload.margin`) fires when the section approaches.
   Loading starts: manifest (optional), then the frame nearest the current position, then a
   sparse pass (every ~N/10th frame, including the last), then fill outward from the current frame.
   If the current neighbourhood has no loaded frame, it is loaded first, so a fast flick or a
   reload mid-section never lands on nothing.
3. The poster stays until the first real frame is painted (`data-ready="1"`). The canvas is never
   shown blank. If the visitor outruns loading, the nearest decoded frame (or the last painted
   frame) stays on screen.
4. A second observer (`activeMargin`) runs the rAF loop and the decoded window only near the
   viewport. Leaving it calls `ImageBitmap.close()` on every decoded frame (blobs are kept);
   re-entry snaps to the current scroll position and re-decodes the window.
5. If the section is on screen and the proximity observer has not fired (custom margins), loading
   starts anyway.

`preload.margin` defaults to "once a pixel is visible" (`-1px` bottom, because an element that
only touches the viewport edge still counts as intersecting). With a hero of exactly `100svh`
above, the sequence therefore starts on the first scroll. Raise it (for example `50% 0px`) to
start earlier. Keep it at or above `activeMargin`.

## Request cancellation

Each sequence owns an `AbortController`. `stopSequence()` (called on every tier change, on
static fallback, and on `destroy()`) marks the sequence dead, aborts the controller and closes its
bitmaps. Every `fetch` carries the signal, so outstanding Tier 1 requests are cancelled when the
engine moves to Tier 2/3/4 instead of draining in the background.

`fetchFrame` resolves `'ok' | 'aborted' | 'failed'` and never rejects. An abort (or a result that
arrives for a dead sequence) resolves `'aborted'`, bumps the aborted counter, and does not touch the
fallback logic. Only genuine failures (HTTP error, network error) count: the first frame failing
degrades one tier, as does `max(3, 10% of N)` failures later. Per-sequence state also removes the
old shared in-flight counter that stale callbacks could corrupt.

Tier 3 stills are cancelled by removing their `src` (best effort in browsers).

## Events (Ambient Hero handoff, analytics)

Dispatched on the section as CustomEvents named `sts-scrub:<name>`, and also
available through `scrub.on(name, fn)`:

| event | when |
|---|---|
| `near` | proximity reached, assets start loading. Hero can warm down |
| `ready` | first real frame painted. The poster/frame 0 handoff is complete |
| `enter` / `leave` | section enters/leaves the active margin (hero can pause once it is mostly off-screen) |
| `tier` | tier changed (`detail.tier`, `.from`, `.reason`) |
| `progress` | every update (subscribers only; not dispatched on the DOM) |

Frame 0 is the poster. For a seamless handoff, use the same pose for the hero's last frame, the
poster and frame 0 of the sequence. That is an asset decision, not an engine one.

## Tiers

| tier | what | when |
|---|---|---|
| 1 | desktop canvas sequence | default on desktop |
| 2 | mobile canvas sequence | small touch screens; first degrade from 1 |
| 3 | stills crossfaded by scroll, poster as base layer | slow connection / low memory; degrade from 2 |
| 4 | static stacked markup, no `.js-scrub` | no JS, reduced motion, save-data, unsupported, failed |

Tiers 1-3 share one stage geometry, so degrading between them causes no layout shift. A resize
that changes the canvas size carries the last painted frame across.

## Diagnostics

`hud: true` (or `?hud=1` with `engineering`) shows the selected frame set, current and target
frame, master and raw progress, active rAF FPS, decoded frames held, estimated decoded memory,
payload loaded, request counts (started/aborted/failed), tier, lerp and DPR.

**Decoded memory is arithmetic, not measurement:** `frames held x w x h x 4` bytes. It is labelled
`EST ... NOT measured` in the HUD. Payload is the sum of the downloaded blob sizes.

## Engineering URL controls (need `engineering: true`)

`?frames=60|90|120` (must be in `availableCounts`) `&tier=1..4` `&win=` `&lerp=` `&track=` `&dpr=`
`&autodrop=0` `&hud=0|1` `&margin=`. Clean device comparison: `?tier=2&autodrop=0`.

## Browser lifecycle notes

- Stage and track use `svh`, so the iOS address bar does not change progress or geometry.
- `resize`, `orientationchange` (re-measured again after 300 ms) and a `ResizeObserver` on the stage re-fit the canvas.
- `pageshow` with `persisted` resets the drawn frame and re-reads scroll (bfcache). There is no `unload` or `beforeunload` handler.
- `visibilitychange` resets the frame clock so a hidden tab does not produce a huge first delta.
- Chapter controls (the CTA) are `tabindex=-1` while their chapter is invisible and restored when visible or in Tier 4.
