'use strict';
/* NB main — boot, fixed-timestep loop, RenderView snapshot, HUD hooks,
   quality ladder, and the capture harness (?autoplay=1 etc.).

   Capture-only query params (never affect normal play):
   - autoplay=1      scripted play: auto-start, auto-serve, paddle tracks ball
   - throwAt=<ms>     in autoplay, freeze the paddle after <ms> (forces a miss)
   - hull=<n>         override starting hull cells
   - theme=<name>     force a theme (swap-test seam; sim untouched)
   - layout=<n>       capture-only: build the sector from LAYOUTS[n-1] (1-8)
   - quality=full|reduced|off
   - debug=1          overlay: fps / quality / entity counts / timescale
   - warpTest=1       sector with a single breakable brick (fast clear->warp)

   Boot: no build step. Open game/index.html, or headless:
   /opt/meta-chromium/chrome --headless=new --screenshot \
     --window-size=1920,1080 --virtual-time-budget=8000 \
     'file:///home/hatch/workspace/games/neon-breaker/game/index.html'
*/
var NB = (window.NB = window.NB || {});

(function () {
  const params = new URLSearchParams(location.search);
  const AUTOPLAY = params.get('autoplay') === '1';
  const THROW_AT = params.has('throwAt') ? parseInt(params.get('throwAt'), 10) : null;
  const HULL_OVERRIDE = params.has('hull') ? parseInt(params.get('hull'), 10) : null;
  const THEME_OVERRIDE = params.get('theme') || null;
  const LAYOUT_OVERRIDE = params.has('layout') ? parseInt(params.get('layout'), 10) : null;
  const QUALITY_OVERRIDE = params.get('quality') || null;
  const DEBUG = params.get('debug') === '1';
  const WARP_TEST = params.get('warpTest') === '1';

  const canvas = document.getElementById('game');
  NB.Renderer.init(canvas);

  let state = NB.Sim.newRun();
  try {
    state.best = parseInt(localStorage.getItem('neon-breaker-best') || '0', 10) || 0;
  } catch (e) { state.best = 0; }

  if (LAYOUT_OVERRIDE != null && LAYOUT_OVERRIDE >= 1 && LAYOUT_OVERRIDE <= 8) {
    // Capture-only layout select: rebuild the sector from LAYOUTS[n-1].
    // Systems, collision, tuning untouched — content seam only.
    NB.Sim._buildSector(state, LAYOUT_OVERRIDE);
  }
  if (HULL_OVERRIDE != null && HULL_OVERRIDE >= 1 && HULL_OVERRIDE <= 5) {
    state.hull = HULL_OVERRIDE;
  }
  if (WARP_TEST) {
    // One breakable brick: clear -> warp happens on first shatter.
    state.bricks = state.bricks.filter(b => b.kind !== 'glass');
    const A = NB.Sim.ARENA;
    state.bricks.unshift({
      x: A.x + A.w / 2 - 46, y: 300, w: 92, h: 30,
      kind: 'glass', hp: 1, maxHp: 1, palette: 0, alive: true, hitFlash: 0,
    });
    state.breakableAlive = 1;
  }

  let themeKey = THEME_OVERRIDE || NB.Themes.order[(state.sector - 1) % NB.Themes.order.length];
  if (!NB.Themes.all[themeKey]) themeKey = 'violet';
  NB.Renderer.setTheme(NB.Themes.all[themeKey], themeKey);

  const vd = NB.VD.create();
  NB.Input.attach(canvas);
  window.addEventListener('pointerdown', () => NB.Audio.unlock(), { passive: true });
  window.addEventListener('keydown', () => NB.Audio.unlock());

  let paused = false;
  let runTime = 0;            // sector timer (HUD)
  let lastSector = state.sector;
  let acc = 0;
  let last = performance.now();
  const DT = NB.Sim.DT;

  // FPS monitor -> quality ladder (auto-degrade, never touches gameplay).
  let fpsAcc = 0, fpsN = 0, fps = 60, lowT = 0, highT = 0;
  let quality = QUALITY_OVERRIDE || 'full';
  NB.Renderer.setQuality(quality);

  // Autoplay harness (capture only).
  const auto = { t0: performance.now(), lastServe: 0, lastFire: 0 };
  const A = NB.Sim.ARENA;

  function predictX(b, targetY) {
    if (b.vy <= 0) return b.x;
    const t = (targetY - b.y) / b.vy;
    if (t < 0 || t > 6) return b.x;
    let x = b.x + b.vx * t;
    const L = A.x + b.r, R = A.x + A.w - b.r, Wd = R - L;
    x = ((x - L) % (2 * Wd) + 2 * Wd) % (2 * Wd);
    if (x > Wd) x = 2 * Wd - x;
    return L + x;
  }

  function autoplay(now, cmd) {
    const elapsed = now - auto.t0;
    const frozen = THROW_AT != null && elapsed > THROW_AT;
    if (state.phase === 'title' && elapsed > 1200) {
      cmd.launchQueued = true;
    } else if (state.phase === 'serve' && now - auto.lastServe > 900) {
      auto.lastServe = now;
      cmd.launchQueued = true;
    } else if (state.phase === 'play' && !frozen) {
      const live = state.balls.filter(b => b.alive && !b.served);
      if (live.length) {
        // Track the lowest ball that is falling; otherwise the lowest ball.
        live.sort((a, b) => b.y - a.y);
        const falling = live.find(b => b.vy > 0);
        const b = falling || live[0];
        cmd.paddleTargetX = predictX(b, NB.Sim.PADDLE_Y - 11);
        cmd.paddleVelDir = 0;
      }
      if (state.paddle.state === 'laser' && now - auto.lastFire > 400) {
        auto.lastFire = now;
        cmd.fireQueued = true;
      }
    }
    // While frozen (throwAt elapsed) the paddle simply stays put: miss follows.
  }

  /* RenderView snapshot: the ONLY sim->render channel besides events.
     Fresh plain objects; the renderer must treat them as read-only. */
  function snapshot() {
    const p = state.paddle;
    return {
      arena: { x: A.x, y: A.y, w: A.w, h: A.h },
      paddle: { x: p.x, width: p.w, state: p.state },
      balls: state.balls.filter(b => b.alive).map(b => (
        { id: b.id, x: b.x, y: b.y, r: b.r, heat: b.heat })),
      bricks: state.bricks.filter(b => b.alive).map(b => (
        { x: b.x, y: b.y, w: b.w, h: b.h, kind: b.kind, alive: true,
          hp: b.hp, maxHp: b.maxHp, palette: b.palette, hitFlash: b.hitFlash })),
      cores: state.cores.map(c => ({ x: c.x, y: c.y, kind: c.kind, t: c.t })),
      shots: state.shots.map(s => ({ x: s.x, y: s.y })),
      hud: {
        score: state.score, best: state.best, newBest: state.newBest,
        combo: state.comboCount, multiplier: state.multiplier,
        comboFrac: state.comboTimer > 0 ? state.comboTimer / 4 : 0,
        timer: runTime,
        court: state.courtPot, courtMax: state.courtMax,
        banked: state.banked,
        hull: state.hull, hullMax: state.hullMax,
        sector: state.sector,
        power: { wide: p.wideT, laser: p.laserT, slow: state.slowT },
      },
      phase: paused ? 'paused' : state.phase,
      debug: DEBUG ? { fps, timeScale: state.timeScale } : null,
    };
  }

  function sfxFor(e) {
    switch (e.t) {
      case 'brickShattered': NB.Audio.shatter(); break;
      case 'brickHit': NB.Audio.brick(); break;
      case 'paddleHit': NB.Audio.paddle(); break;
      case 'ballLaunched': NB.Audio.launch(); break;
      case 'coreCaught': NB.Audio.core(); break;
      case 'hullLost': NB.Audio.lose(); break;
      case 'sectorCleared': NB.Audio.clear(); break;
      case 'laserFired': NB.Audio.laser(); break;
    }
  }

  function frame(now) {
    let realDt = (now - last) / 1000;
    last = now;
    if (realDt > 0.1) realDt = 0.1; // tab-switch clamp
    if (realDt < 0) realDt = 0; // D1 fix: non-monotonic rAF timestamps (VM clock
    // adjustments) made realDt negative, which pushed vd.paddleFlash above 1
    // and threw an uncaught IndexSizeError in the paddle-flash ellipse.

    const cmd = NB.Input.consume();
    if (AUTOPLAY) autoplay(now, cmd);

    if (cmd.pauseToggled && (state.phase === 'play' || state.phase === 'serve')) {
      paused = !paused;
    }
    if (cmd.restartQueued) { paused = false; runTime = 0; }

    state.events.length = 0;
    if (!paused) {
      // Slow-mo is a timeScale on the accumulator; render/UI stay real-time.
      acc += realDt * state.timeScale;
      let n = 0;
      while (acc >= DT && n < 40) {
        NB.Sim.step(state, cmd, realDt, DT);
        acc -= DT;
        n++;
      }
      if (n === 40) acc = 0; // spiral-of-death guard
      if (state.phase === 'play' || state.phase === 'serve') runTime += realDt;
      if (state.sector !== lastSector) {
        // Theme + material swap on sector change (sim untouched).
        lastSector = state.sector;
        runTime = 0;
        if (!THEME_OVERRIDE) {
          themeKey = NB.Themes.order[(state.sector - 1) % NB.Themes.order.length];
          NB.Renderer.setTheme(NB.Themes.all[themeKey], themeKey);
        }
      }
    }

    const events = state.events.slice();
    for (const e of events) sfxFor(e);
    if (state.newBest) {
      try { localStorage.setItem('neon-breaker-best', String(state.best)); } catch (e) {}
    }

    const view = snapshot();
    NB.VD.update(vd, events, view, NB.Renderer.getTheme(), paused ? 0 : realDt, quality);
    NB.Renderer.render(view, vd, paused ? 0 : realDt);

    // FPS monitor -> auto quality ladder.
    fpsAcc += realDt; fpsN++;
    if (fpsAcc >= 0.5) {
      fps = fpsN / fpsAcc; fpsAcc = 0; fpsN = 0;
      if (!QUALITY_OVERRIDE) {
        if (fps < 55) { lowT += 0.5; highT = 0; } else { lowT = 0; }
        if (fps > 58) { highT += 0.5; } else { highT = 0; }
        if (lowT >= 2 && quality === 'full') { quality = 'reduced'; NB.Renderer.setQuality('reduced'); lowT = 0; }
        else if (lowT >= 2 && quality === 'reduced') { quality = 'off'; NB.Renderer.setQuality('off'); lowT = 0; }
        else if (highT >= 5 && quality !== 'full') {
          quality = quality === 'off' ? 'reduced' : 'full';
          NB.Renderer.setQuality(quality); highT = 0;
        }
      }
    }

    requestAnimationFrame(frame);
  }

  // Debug surface (capture/headless inspection only).
  window.__nb = { state: () => state, version: 'stage-b' };

  requestAnimationFrame(frame);
})();
