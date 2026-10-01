'use strict';
/* NB.Sim — gameplay simulation. Pure data + fixed-timestep systems.
   NEVER touches the DOM or canvas. The renderer reads the sim only
   through the per-frame RenderView snapshot plus the event queue. */
var NB = (window.NB = window.NB || {});

NB.Sim = (() => {
  const DT = 1 / 120;               // fixed sim substep
  const ARENA = { x: 360, y: 140, w: 1200, h: 740 };
  const LOSS_Y = 880;               // ball-loss line (bottom edge open)
  const PADDLE_Y = 812;             // paddle center (band 801..823, above loss line)
  const PADDLE_H = 22;
  const PADDLE_W = 150;
  const BALL_R = 13;
  const COMBO_WINDOW = 4;           // seconds to keep the combo alive
  const LADDER_HITS = [0, 4, 8, 14, 22, 32];
  const LADDER_MULT = [1, 2, 3, 5, 8, 13];
  const HULL_MAX = 5;
  const COLS = 12, BW = 92, BH = 30, GX = 8, GY = 10;
  const GRID_X0 = ARENA.x + (ARENA.w - (COLS * BW + (COLS - 1) * GX)) / 2;
  const GRID_Y0 = 178;
  const PADDLE_SPEED_KEY = 980;     // px/s in velocity mode
  const PADDLE_SPEED_MOUSE = 1750;  // px/s toward mouse target
  const CORE_FALL = 210;
  const SHOT_SPEED = 1500;
  const LASER_CD = 0.28;

  // ASCII level maps: # glass 1HP, 2 glass 2HP, 3 glass 3HP,
  // H hazard (breakable, excluded from clear count), X unbreakable.
  const LAYOUTS = [
    [
      '............',
      '..###..###..',
      '...##..##...',
      '....####....',
      '...##22##...',
      '....#22#....',
      '.....##.....',
    ],
    [
      '.##..22..##.',
      '.##..22..##.',
      '.##..HH..##.',
      '.##......##.',
      '............',
      '............',
      '............',
    ],
    [
      '.....##.....',
      '....#22#....',
      '...#2222#...',
      '..#22HH22#..',
      '...#2222#...',
      '....#22#....',
      '.....##.....',
    ],
    [ // L4: breach wall (glacier) — reworked from a stamped grid to a
      // varied wall with breaches, armored ribs and unbreakable teeth.
      '###.##.##.##',
      '##222##222##',
      '#2##X##X##2#',
      '##222##222##',
      '###.##.##.##',
    ],
    [ // L5: twin arcs (violet)
      '..###..###..',
      '.#####.#####',
      '###2#.#.2###',
      '##22#..#22##',
      '.....##.....',
    ],
    [ // L6: chevrons (abyssal)
      '.....##.....',
      '....#22#....',
      '...#2222#...',
      '..#22##22#..',
      '.#2##..##2#.',
      '#2#......#2#',
      '............',
    ],
    [ // L7: hazard clusters (ember) — H on row index 2 renders as
      // diamond hazard bricks (kind hazard + palette 2).
      '##....##....',
      '222..##..222',
      '##..H..H..##',
      '............',
      '..###..###..',
      '..222..222..',
      '............',
    ],
    [ // L8: fortress (violet) — unbreakable frame, armored core
      'XXXXXXXXXXXX',
      'X2222222222X',
      'X2########2X',
      'X2#222222#2X',
      'X2#2XXXX2#2X',
      'X2#222222#2X',
      '............',
    ],
  ];

  const CORE_KINDS = ['multi', 'wide', 'laser', 'slow', 'hull'];
  const CORE_WEIGHTS = [0.30, 0.25, 0.18, 0.12, 0.15]; // hull ~1.8% of breaks

  function ballSpeed(sector) { return Math.min(520 + 60 * (sector - 1), 1250); }
  function paddleTopY() { return PADDLE_Y - PADDLE_H / 2; }
  function ladderMult(hits) {
    let m = 1;
    for (let i = 0; i < LADDER_HITS.length; i++) if (hits >= LADDER_HITS[i]) m = LADDER_MULT[i];
    return m;
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- sector construction ---------- */

  function brickKind(ch) {
    if (ch === '#') return { kind: 'glass', hp: 1 };
    if (ch === '2') return { kind: 'glass', hp: 2 };
    if (ch === '3') return { kind: 'glass', hp: 3 };
    if (ch === 'H') return { kind: 'hazard', hp: 2 };
    if (ch === 'X') return { kind: 'unbreakable', hp: 1e9 };
    return null;
  }

  function buildSector(st, idx) {
    const layout = LAYOUTS[(idx - 1) % LAYOUTS.length];
    const promote = Math.min(0.15 * (idx - 1), 0.6); // escalate HP with sector
    st.bricks.length = 0;
    st.breakableAlive = 0;
    for (let r = 0; r < layout.length; r++) {
      const row = layout[r];
      for (let c = 0; c < Math.min(COLS, row.length); c++) {
        const spec = brickKind(row[c]);
        if (!spec) continue;
        // Escalation: promote glass HP, sprinkle hazards from sector 3.
        if (spec.kind === 'glass') {
          const roll = Math.random();
          if (spec.hp === 1 && roll < promote) spec.hp = 2;
          else if (spec.hp === 2 && roll < promote * 0.7) spec.hp = 3;
          if (idx >= 3 && Math.random() < 0.08) { spec.kind = 'hazard'; spec.hp = 2; }
        }
        const b = {
          x: GRID_X0 + c * (BW + GX), y: GRID_Y0 + r * (BH + GY),
          w: BW, h: BH,
          kind: spec.kind, hp: spec.hp, maxHp: spec.hp,
          palette: r % 3, alive: true, hitFlash: 0,
        };
        st.bricks.push(b);
        if (spec.kind === 'glass') st.breakableAlive++;
      }
    }
  }

  /* ---------- run lifecycle ---------- */

  function newRun() {
    const st = {
      phase: 'title',      // title|serve|play|clear|warp|gameover
      phaseT: 0,
      sector: 1,
      score: 0, best: 0, newBest: false,
      comboCount: 0, comboTimer: 0, multiplier: 1,
      courtPot: 0, courtMax: 1,
      hull: 3, hullMax: HULL_MAX,
      timeScale: 1, slowT: 0, beatT: 0,
      serveT: 0, clearT: 0, warpT: 0, banked: 0,
      paddle: null, balls: [], bricks: [], cores: [], shots: [],
      breakableAlive: 0,
      events: [],
      arena: { ...ARENA },
    };
    resetPaddle(st);
    buildSector(st, 1);
    st.courtMax = 250000; st.courtPot = st.courtMax;
    startServe(st);
    st.phase = 'title';
    return st;
  }

  function resetPaddle(st) {
    st.paddle = {
      x: ARENA.x + ARENA.w / 2, w: PADDLE_W, baseW: PADDLE_W,
      targetX: null, state: 'normal', // normal|wide|laser
      wideT: 0, laserT: 0, laserCd: 0,
    };
  }

  function startServe(st) {
    st.balls.length = 0;
    st.cores.length = 0;
    st.shots.length = 0;
    st.balls.push({ x: st.paddle.x, y: paddleTopY() - BALL_R - 1, vx: 0, vy: 0,
                    r: BALL_R, heat: 0.2, alive: true, served: true, id: 1 });
    st.phase = 'serve';
    st.serveT = 0;
  }

  function nextSector(st) {
    st.sector++;
    resetPaddle(st);
    buildSector(st, st.sector);
    st.courtMax = 250000 * st.sector;
    st.courtPot = st.courtMax;
    st.comboCount = 0; st.comboTimer = 0; st.multiplier = 1;
    startServe(st);
  }

  /* ---------- events ---------- */

  function emit(st, ev) { st.events.push(ev); }

  function registerHit(st) {
    st.comboCount++;
    st.comboTimer = COMBO_WINDOW;
    const m = ladderMult(st.comboCount);
    if (m > st.multiplier) {
      st.multiplier = m;
      emit(st, { t: 'multiplierUp', mult: m, combo: st.comboCount });
    }
  }

  function addScore(st, base, x, y, label) {
    const gained = base * st.multiplier;
    st.score += gained;
    emit(st, { t: 'scorePop', x, y, text: '+' + gained, mult: st.multiplier, label: label || '' });
    return gained;
  }

  function damageBrick(st, brick, ev, byShot) {
    const cx = brick.x + brick.w / 2, cy = brick.y + brick.h / 2;
    if (brick.kind === 'unbreakable') {
      brick.hitFlash = 1;
      addScore(st, 10, cx, cy, '');
      ev.push({ t: 'brickHit', x: cx, y: cy, kind: 'unbreakable', thud: true });
      return;
    }
    brick.hp--;
    brick.hitFlash = 1;
    registerHit(st);
    if (brick.hp <= 0) {
      brick.alive = false;
      const base = brick.kind === 'hazard' ? 150 : 100 * brick.maxHp;
      addScore(st, base, cx, cy, brick.kind === 'hazard' ? 'HAZARD' : '');
      ev.push({ t: 'brickShattered', x: cx, y: cy, kind: brick.kind,
                palette: brick.palette, hp: brick.maxHp });
      if (brick.kind === 'glass') {
        st.breakableAlive--;
        maybeDropCore(st, cx, cy, ev);
      }
    } else {
      ev.push({ t: 'brickHit', x: cx, y: cy, kind: brick.kind, thud: false });
    }
  }

  function maybeDropCore(st, x, y, ev) {
    if (Math.random() >= 0.12) return; // ~12% drop rate
    const roll = Math.random();
    let kind = CORE_KINDS[0], acc = 0;
    for (let i = 0; i < CORE_KINDS.length; i++) {
      acc += CORE_WEIGHTS[i];
      if (roll <= acc) { kind = CORE_KINDS[i]; break; }
    }
    st.cores.push({ x, y, vy: CORE_FALL, kind, t: Math.random() * 6.28, alive: true });
    ev.push({ t: 'coreSpawned', x, y, kind });
  }

  function applyCore(st, kind, ev) {
    const p = st.paddle;
    if (kind === 'multi') {
      const live = st.balls.filter(b => b.alive && !b.served);
      let id = 1000 + st.balls.length;
      for (const b of live) {
        if (st.balls.filter(x => x.alive).length >= 4) break;
        const a = Math.atan2(b.vy, b.vx) + (Math.random() < 0.5 ? 0.6 : -0.6);
        const sp = Math.hypot(b.vx, b.vy);
        st.balls.push({ x: b.x, y: b.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                        r: BALL_R, heat: b.heat, alive: true, served: false, id: id++ });
      }
      ev.push({ t: 'coreCaught', kind, label: 'MULTI-BALL' });
    } else if (kind === 'wide') {
      p.state = 'wide'; p.w = p.baseW * 1.5; p.wideT = 20; p.laserT = 0;
      ev.push({ t: 'coreCaught', kind, label: 'WIDE PADDLE' });
    } else if (kind === 'laser') {
      p.state = 'laser'; p.w = p.baseW; p.laserT = 12; p.wideT = 0;
      ev.push({ t: 'coreCaught', kind, label: 'LASER' });
    } else if (kind === 'slow') {
      st.slowT = 8;
      ev.push({ t: 'coreCaught', kind, label: 'SLOW-MO' });
    } else if (kind === 'hull') {
      st.hull = Math.min(st.hull + 1, st.hullMax);
      ev.push({ t: 'coreCaught', kind, label: '+1 HULL' });
    }
  }

  function doLaunch(st, ev) {
    const b = st.balls.find(x => x.alive && x.served);
    if (!b) return;
    const sp = ballSpeed(st.sector);
    const aim = clamp((st.paddle.x - (ARENA.x + ARENA.w / 2)) / (ARENA.w / 2), -1, 1);
    const ang = aim * 0.6 + (Math.random() - 0.5) * 0.15;
    b.served = false;
    b.vx = Math.sin(ang) * sp;
    b.vy = -Math.cos(ang) * sp;
    b.heat = 0.35;
    st.phase = 'play';
    ev.push({ t: 'ballLaunched', x: b.x, y: b.y });
  }

  function fireLasers(st, ev) {
    const p = st.paddle;
    const y = paddleTopY() - 6;
    const off = p.w / 2 - 16;
    st.shots.push({ x: p.x - off, y, vy: -SHOT_SPEED, alive: true });
    st.shots.push({ x: p.x + off, y, vy: -SHOT_SPEED, alive: true });
    p.laserCd = LASER_CD;
    ev.push({ t: 'laserFired', x: p.x, y });
  }

  /* ---------- swept collision ---------- */

  // Swept circle vs AABB: expand the box by r, ray-cast the center.
  // Returns {t, nx, ny} with t in [0,1], or null.
  function sweptCircleBox(px, py, dx, dy, r, bx, by, bw, bh) {
    const minx = bx - r, maxx = bx + bw + r;
    const miny = by - r, maxy = by + bh + r;
    let t0 = 0, t1 = 1, nx = 0, ny = 0;
    if (Math.abs(dx) < 1e-9) {
      if (px < minx || px > maxx) return null;
    } else {
      let ta = (minx - px) / dx, tb = (maxx - px) / dx, sx = -1;
      if (ta > tb) { const tt = ta; ta = tb; tb = tt; sx = 1; }
      if (ta > t0) { t0 = ta; nx = sx; ny = 0; }
      t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    if (Math.abs(dy) < 1e-9) {
      if (py < miny || py > maxy) return null;
    } else {
      let ta = (miny - py) / dy, tb = (maxy - py) / dy, sy = -1;
      if (ta > tb) { const tt = ta; ta = tb; tb = tt; sy = 1; }
      if (ta > t0) { t0 = ta; nx = 0; ny = sy; }
      t1 = Math.min(t1, tb);
      if (t0 > t1) return null;
    }
    if (t0 < 0 || t0 > 1) return null;
    if (nx === 0 && ny === 0) return { t: 0, nx: 0, ny: dy > 0 ? -1 : 1 };
    return { t: t0, nx, ny };
  }

  function paddleRect(st) {
    const p = st.paddle;
    return { x: p.x - p.w / 2, y: paddleTopY(), w: p.w, h: PADDLE_H };
  }

  function bounceOffPaddle(st, b, ev) {
    const p = st.paddle;
    const sp = ballSpeed(st.sector);
    const off = clamp((b.x - p.x) / (p.w / 2), -1, 1);
    const ang = off * 1.15; // up to ~66 deg from vertical
    b.vx = Math.sin(ang) * sp;
    b.vy = -Math.cos(ang) * sp;
    b.heat = Math.min(1, b.heat + 0.12);
    ev.push({ t: 'paddleHit', x: b.x, y: paddleTopY() });
  }

  function moveBall(st, b, dt, ev) {
    let px = b.x, py = b.y;
    let dx = b.vx * dt, dy = b.vy * dt;
    const pr = paddleRect(st);
    for (let iter = 0; iter < 4; iter++) {
      let best = null, hit = null; // hit: {type:'wall'|'paddle'|'brick', brick}
      if (dx < 0) { // left wall
        const t = (ARENA.x + b.r - px) / dx;
        if (t >= 0 && t <= 1 && (!best || t < best.t)) { best = { t, nx: 1, ny: 0 }; hit = { type: 'wall' }; }
      } else if (dx > 0) { // right wall
        const t = (ARENA.x + ARENA.w - b.r - px) / dx;
        if (t >= 0 && t <= 1 && (!best || t < best.t)) { best = { t, nx: -1, ny: 0 }; hit = { type: 'wall' }; }
      }
      if (dy < 0) { // top wall
        const t = (ARENA.y + b.r - py) / dy;
        if (t >= 0 && t <= 1 && (!best || t < best.t)) { best = { t, nx: 0, ny: 1 }; hit = { type: 'wall' }; }
      }
      if (dy > 0) { // paddle
        const s = sweptCircleBox(px, py, dx, dy, b.r, pr.x, pr.y, pr.w, pr.h);
        if (s && (!best || s.t < best.t)) { best = s; hit = { type: 'paddle' }; }
      }
      for (const br of st.bricks) { // bricks
        if (!br.alive) continue;
        const s = sweptCircleBox(px, py, dx, dy, b.r, br.x, br.y, br.w, br.h);
        if (s && (!best || s.t < best.t)) { best = s; hit = { type: 'brick', brick: br }; }
      }
      if (!best) break;
      px += dx * best.t; py += dy * best.t;
      if (hit.type === 'paddle') {
        bounceOffPaddle(st, b, ev);
        dx = b.vx * dt * (1 - best.t); dy = b.vy * dt * (1 - best.t);
      } else {
        if (best.nx !== 0) { b.vx = -b.vx; dx = -dx; }
        if (best.ny !== 0) { b.vy = -b.vy; dy = -dy; }
        const rem = 1 - best.t;
        dx *= rem; dy *= rem;
        if (hit.type === 'brick') damageBrick(st, hit.brick, ev, false);
        else ev.push({ t: 'wallHit', x: px, y: py });
      }
      px += best.nx * 0.6; py += best.ny * 0.6; // de-penetrate
      // Keep the ball out of near-horizontal lock.
      const sp = Math.hypot(b.vx, b.vy) || 1;
      if (Math.abs(b.vy) < 0.28 * sp) {
        const sy = b.vy >= 0 ? 1 : -1;
        b.vy = sy * 0.28 * sp;
        b.vx = (b.vx >= 0 ? 1 : -1) * Math.sqrt(Math.max(sp * sp - b.vy * b.vy, 1));
        dx = b.vx * dt * (1 - best.t); dy = b.vy * dt * (1 - best.t);
      }
    }
    b.x = px + dx; b.y = py + dy;
    b.heat = clamp(b.heat - dt * 0.15, 0.1, 1);
    if (b.y - b.r > LOSS_Y) {
      b.alive = false;
      ev.push({ t: 'ballLost', x: b.x, y: LOSS_Y });
    }
  }

  /* ---------- systems (fixed order per substep) ---------- */

  function inputSys(st, cmd, ev) {
    if (cmd._used) return;
    cmd._used = true;
    if (cmd.restartQueued) {
      const best = st.best;
      const fresh = newRun();
      fresh.best = best;
      for (const k of Object.keys(fresh)) st[k] = fresh[k];
      return;
    }
    if (cmd.launchQueued) {
      if (st.phase === 'title') { st.phase = 'serve'; st.serveT = 0; }
      else if (st.phase === 'serve') doLaunch(st, ev);
      else if (st.phase === 'gameover') {
        const best = st.best, nb = st.newBest;
        const fresh = newRun();
        fresh.best = best; fresh.newBest = nb;
        for (const k of Object.keys(fresh)) st[k] = fresh[k];
      }
    }
    if (cmd.fireQueued && st.phase === 'play' && st.paddle.state === 'laser' && st.paddle.laserCd <= 0) {
      fireLasers(st, ev);
    }
  }

  function paddleSys(st, cmd, dt) {
    const p = st.paddle;
    const minX = ARENA.x + p.w / 2, maxX = ARENA.x + ARENA.w - p.w / 2;
    if (cmd.paddleVelDir !== 0) {
      p.x += cmd.paddleVelDir * PADDLE_SPEED_KEY * dt;
    } else if (cmd.paddleTargetX != null) {
      const d = cmd.paddleTargetX - p.x;
      const step = clamp(d, -PADDLE_SPEED_MOUSE * dt, PADDLE_SPEED_MOUSE * dt);
      p.x += step;
    }
    p.x = clamp(p.x, minX, maxX);
  }

  function ballSys(st, dt, ev) {
    for (const b of st.balls) {
      if (!b.alive) continue;
      if (b.served) {
        b.x = st.paddle.x;
        b.y = paddleTopY() - b.r - 1;
        continue;
      }
      moveBall(st, b, dt, ev);
    }
    // Remove dead balls; a lost last ball costs a hull cell.
    st.balls = st.balls.filter(b => b.alive);
    if (st.balls.length === 0 && st.phase === 'play') {
      st.hull--;
      st.comboCount = 0; st.comboTimer = 0; st.multiplier = 1;
      emit(st, { t: 'hullLost', hull: st.hull });
      st.beatT = 0.7; // slow-mo beat on ball loss
      if (st.hull <= 0) {
        st.phase = 'gameover';
        st.phaseT = 0;
        if (st.score > st.best) { st.best = st.score; st.newBest = true; }
        emit(st, { t: 'gameOver', score: st.score, best: st.best });
      } else {
        startServe(st);
      }
    }
  }

  function coreSys(st, dt, ev) {
    const pr = paddleRect(st);
    for (const c of st.cores) {
      if (!c.alive) continue;
      c.t += dt * 4;
      c.y += c.vy * dt;
      c.x += Math.sin(c.t) * 40 * dt;
      if (c.y > LOSS_Y + 30) {
        c.alive = false;
        ev.push({ t: 'coreMissed', x: c.x, y: LOSS_Y, kind: c.kind });
      } else if (c.y + 14 > pr.y && c.y - 14 < pr.y + pr.h &&
                 c.x > pr.x - 14 && c.x < pr.x + pr.w + 14) {
        c.alive = false;
        applyCore(st, c.kind, ev);
      }
    }
    st.cores = st.cores.filter(c => c.alive);
  }

  function shotSys(st, dt, ev) {
    for (const s of st.shots) {
      if (!s.alive) continue;
      s.y += s.vy * dt;
      if (s.y < ARENA.y) { s.alive = false; continue; }
      for (const br of st.bricks) {
        if (!br.alive) continue;
        if (s.x > br.x && s.x < br.x + br.w && s.y > br.y && s.y < br.y + br.h) {
          s.alive = false;
          damageBrick(st, br, ev, true);
          break;
        }
      }
    }
    st.shots = st.shots.filter(s => s.alive);
  }

  function comboSys(st, dt) {
    if (st.comboTimer > 0) {
      st.comboTimer -= dt;
      if (st.comboTimer <= 0) { st.comboCount = 0; st.multiplier = 1; }
    }
    for (const br of st.bricks) if (br.hitFlash > 0) br.hitFlash = Math.max(0, br.hitFlash - dt * 5);
  }

  function sectorSys(st, ev) {
    if ((st.phase === 'play' || st.phase === 'serve') && st.breakableAlive <= 0) {
      st.phase = 'clear';
      st.clearT = 1.2;
      emit(st, { t: 'clearBeat' });
    }
  }

  /* ---------- step ---------- */

  // realDt: wall-clock seconds (timers, cinematics). simDt: scaled physics step.
  function step(st, cmd, realDt, simDt) {
    st.phaseT += realDt;

    // Real-time timers.
    st.serveT += realDt;
    if (st.slowT > 0) st.slowT = Math.max(0, st.slowT - realDt);
    if (st.beatT > 0) st.beatT = Math.max(0, st.beatT - realDt);
    const p = st.paddle;
    if (p.wideT > 0) { p.wideT = Math.max(0, p.wideT - realDt); if (p.wideT === 0 && p.state === 'wide') { p.state = 'normal'; p.w = p.baseW; } }
    if (p.laserT > 0) { p.laserT = Math.max(0, p.laserT - realDt); if (p.laserT === 0 && p.state === 'laser') { p.state = 'normal'; p.w = p.baseW; } }
    if (p.laserCd > 0) p.laserCd = Math.max(0, p.laserCd - realDt);

    // Slow-mo: power core, clear beat, ball-loss beat (deepest wins).
    st.timeScale = 1;
    if (st.slowT > 0) st.timeScale = 0.45;
    if (st.phase === 'clear') st.timeScale = Math.min(st.timeScale, 0.25);
    if (st.beatT > 0) st.timeScale = Math.min(st.timeScale, 0.3);

    // Phase cinematics (real time).
    if (st.phase === 'clear') {
      st.clearT -= realDt;
      if (st.clearT <= 0) {
        st.banked = Math.round(st.courtPot);
        st.score += st.banked;
        emit(st, { t: 'sectorCleared', sector: st.sector, banked: st.banked });
        emit(st, { t: 'warpStarted', sector: st.sector });
        st.phase = 'warp';
        st.warpT = 2.5;
        st.phaseT = 0;
      }
    } else if (st.phase === 'warp') {
      st.warpT -= realDt;
      if (st.warpT <= 0) nextSector(st);
    }

    // Court pot drains while the sector is uncleared.
    if (st.phase === 'play' || st.phase === 'serve') {
      st.courtPot = Math.max(0, st.courtPot - (st.courtMax / 150) * simDt);
    }

    // Fixed-order systems (sim time).
    inputSys(st, cmd, st.events);
    if (st.phase === 'play' || st.phase === 'serve') {
      paddleSys(st, cmd, simDt);
      ballSys(st, simDt, st.events);
      coreSys(st, simDt, st.events);
      shotSys(st, simDt, st.events);
      comboSys(st, simDt);
      sectorSys(st, st.events);
    }
  }

  return {
    DT, ARENA, LOSS_Y, PADDLE_Y, PADDLE_H, BALL_R,
    newRun, step, ballSpeed, ladderMult,
    _sweptCircleBox: sweptCircleBox, // exposed for headless tests
    _buildSector: buildSector, // capture-only layout select (see main.js)
  };
})();
