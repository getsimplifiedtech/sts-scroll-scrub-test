# STS Scroll-Scrub Cinematic Experience

STS Product #2: a frame-addressable cinematic sequence where native scroll position drives a
canvas-rendered visual timeline and synchronized narrative content. It is separate from
Product #1 (Ambient Cinematic Hero) and is designed to sit directly beneath it.

Engine: `scrub.js` (no dependencies). Styles: `scrub.css`. Reference page: `index.html`.
Full documentation: [`docs/ENGINE.md`](docs/ENGINE.md).

## Locked architecture

- Static-first page; the section is complete and readable without JavaScript. The engine adds
  `.js-scrub` to the section only after capability checks pass.
- Native `position: sticky` stage in a tall track, one `requestAnimationFrame` loop, one
  normalized master progress (0..1). No scroll hijacking.
- Canvas image sequence with a sliding decoded-frame window (`ImageBitmap.close()` on eviction).
- Four-tier fallback: full canvas sequence, mobile canvas sequence, stills crossfade, static.
- No GSAP or Lenis in the core engine.

## Defaults

- **90 frames** is the STS baseline default (first real-device iPhone comparison). 60 is the
  lighter alternative and 120 is optional for sequences that visibly benefit. These are
  starting points for future builds, not immutable requirements.
- Request cancellation per sequence (`AbortController`) and proximity-based loading: nothing
  heavy downloads at page start.

## Engineering controls

Enabled only when the section config has `"engineering": true` (the demo does; production
should not). They are for measurement, not product controls.

- `?frames=60|90|120`, `?tier=1|2|3|4`, `?win=12`, `?lerp=0.14`, `?track=300`, `?dpr=1.5`
- `?autodrop=0` disables automatic tier drop, `?hud=0|1` toggles the diagnostics HUD,
  `?margin=` overrides the proximity margin

For clean iPhone comparisons use `?tier=2&autodrop=0`.

## Assets

The GitHub Pages workflow downloads the approved 1280x768 production burger clip from the STS
hero-assets repository, generates desktop and mobile WebP frame sets (60, 90, 120), builds the
manifest and deploys the static demo. The burger clip is not changed by this work.

## Tests

```
node tests/serve.cjs . 8123 &
node tests/validate.cjs     # Playwright + chromium; prints PASSED: n ok, 0 failed
```

The suite covers the cases listed in `docs/ENGINE.md`. Real-device behaviour (iOS Safari
address bar, real bfcache, thermal throttling) needs real-device validation.
