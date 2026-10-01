# NEON BREAKER — playable build (Stage B)

Vanilla HTML5 Canvas 2D + JS. No build step, no dependencies, no assets:
open `game/index.html` in a browser.

## Verify boot (headless Chromium)

Canonical command:

```sh
/opt/meta-chromium/chrome --headless=new --no-sandbox --disable-gpu \
  --screenshot=/tmp/nb-boot.png --window-size=1920,1080 \
  --virtual-time-budget=8000 --enable-logging=stderr \
  --dump-dom=/tmp/nb-dom.html \
  'file:///home/hatch/workspace/games/neon-breaker/game/index.html' \
  2>/tmp/nb-stderr.log
echo "exit=$?"
grep -o 'data-boot-errors="[0-9]*"' /tmp/nb-dom.html   # must be "0"
grep -ci 'uncaught' /tmp/nb-stderr.log                # informational
```

Boot passes when: exit code 0 **and** `data-boot-errors="0"` in the dumped
DOM (an inline pre-script registers `window.onerror` /
`unhandledrejection` and counts failures into that attribute).

> Environment notes (Stage B, 2026-09-30). `--no-sandbox` is required when
> running as root. This Chromium build (152.0.7977.82) does not write
> `--screenshot` / `--dump-dom` output, so Stage B verification ran through
> a CDP harness instead (fresh chrome per capture, `file://` URL as the
> startup page, `Page.captureScreenshot`, boot errors read from
> `#boot-errors[data-boot-errors]` via the DOM domain — no virtual time,
> real-time waits). `http://127.0.0.1` serving is blocked in this build by
> Local Network Access checks, hence `file://`. All captures passed with
> `data-boot-errors="0"` and zero uncaught exceptions.

## Capture frames (1920x1080)

```sh
/opt/meta-chromium/chrome --headless=new --disable-gpu \
  --screenshot=artifacts/stage-b/loop-frames/01-title.png \
  --window-size=1920,1080 --virtual-time-budget=3000 \
  'file:///home/hatch/workspace/games/neon-breaker/game/index.html'
```

Capture-only query params (scripted play; never affect normal play):

| param | effect |
|---|---|
| `autoplay=1` | auto-start, auto-serve, paddle tracks the ball |
| `throwAt=<ms>` | freeze the paddle after `<ms>` (forces a miss) |
| `hull=<n>` | starting hull cells |
| `theme=<name>` | force theme: `violet` `ember` `glacier` `abyssal` |
| `warpTest=1` | single breakable brick → fast clear → warp |
| `quality=full\|reduced\|off` | post-FX chain level |
| `debug=1` | overlay: fps / quality / entities / timescale |

## Renderer-contract swap test

The look layer is `js/themes.js` (`NB.Themes`: palette + key light + grade)
plus `NB.Materials` in `js/renderer.js`. The sim (`js/sim.js`) never reads
either. Proof: capture the same moment under two themes — e.g.

```sh
... '.../game/index.html?autoplay=1&theme=violet'   # default key light
... '.../game/index.html?autoplay=1&theme=glacier'  # different key light + brick set
```

— and diff the sim: `js/sim.js` is untouched; only the Theme object and
material specs change. The seam is `Renderer.setTheme(theme, key)` →
`Materials.warm(theme)` → cached per-(kind, hp, theme) specs, rebuilt at
sector transitions.

## Controls

Mouse or ←/→ (A/D) to move · click / Space to launch & fire laser ·
P pause · R restart · M mute.

## Architecture (per PLAN.md)

`js/input.js` (events → commands) → `js/sim.js` (fixed 1/120 s systems,
emits events; no DOM/canvas) → `js/renderer.js` (VisualDirector consumes
events → 14-layer draw from a read-only RenderView snapshot) →
`js/themes.js` (swappable look), `js/audio.js` (synth SFX, silent headless),
`js/main.js` (loop, snapshot, quality ladder, capture harness).

## Publish

**LOCKED.** Local playable build only. No deploys, no sharing beyond the user.
