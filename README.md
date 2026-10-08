# STS Scroll-Scrub Cinematic Experience — Measurement Spike

This repository is the iPhone/device measurement spike for the STS Scroll-Scrub Cinematic Experience.

## Locked architecture

- Static-first page; JavaScript adds `.js-scrub` only after capability checks pass.
- Native `position: sticky` stage with one `requestAnimationFrame` loop.
- Canvas image sequence with a sliding decoded-frame window.
- Four-tier fallback.
- No GSAP or Lenis required for the core scrub engine.

## Test variants

- `?frames=60`
- `?frames=90`
- `?frames=120`

For clean iPhone comparisons, use `&tier=2&autodrop=0`.

The GitHub Pages workflow downloads the approved 1280×768 production burger clip from the STS hero-assets repository, generates desktop and mobile WebP frame sets, builds the manifest, and deploys the static spike.

This is a measurement build, not the final production component.
