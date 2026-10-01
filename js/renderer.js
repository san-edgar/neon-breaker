'use strict';
/* NB.Renderer — pure function of (RenderView, Theme, Materials, PostChain,
   HudSkin) plus its own visual-entity state. It owns no game rules and
   never mutates sim entities.

   Seams (stable gameplay <-> swappable look):
   - NB.Materials: makeBrick/makePaddle/makeCore/ballHeat/glow. Stage B
     returns draw-spec data; Stage C can return pre-rendered sprites
     without touching the sim or the call sites.
   - Theme: plain data object (themes.js). ?theme=<name> swaps the whole
     look (palette + key light) with zero sim changes. */
var NB = (window.NB = window.NB || {});

/* Fixed camera: world == screen pixels. Shake is a transient render-space
   offset applied by the renderer; the sim never sees it. */
NB.Camera = { x: 0, y: 0 };

/* C1 lighting rig (LOOK.md): one baked key light at top-center with a
   top-left specular/rim azimuth on every sprite — one readable light
   direction across the scene. Dual-tone ambient/IBL fill keeps shadows
   saturated, never black. Fake AO: contact ellipses under bricks/paddle
   plus inner bottom darkening inside bricks. Fog/depth gradients baked
   into background and arena caches. Grade pass: vignette -> S-curve
   (soft-light) -> per-theme lift -> animated grain; red vignette pulse
   and warm flash are event overlays. Selective 1/4-res bloom on bright
   elements only (balls, cores, flashes, shockwaves). HUD is drawn after
   post: never bloomed, never shaken. */

/* ---------------- MaterialFactory (pre-rendered sprites, C2) ----------------
   Every hero material is authored as procedural canvas art, baked once per
   (theme, kind, hp, palette) into offscreen sprites; hot paths only blit.
   Light grammar (LOOK.md): key azimuth top-left — top/left edges lit,
   bottom/right fall to shadow. Glass brick: dark base -> inner vertical
   gradient -> diagonal specular streak -> glyph emblem -> directional rim
   -> inner bottom AO. Variants: armored (deeper + extra glyph + cracks),
   hazard red glass (R3/R4), diamond near-black + orange icon (R6),
   unbreakable gunmetal. Power-core carrier is a renderer-only sigil
   marker; the drop itself stays sim-random. */
NB.Materials = (() => {
  let themeName = '', curTheme = null;
  const brickCache = new Map();   // kind:hp:pal -> canvas
  const ballCache = new Map();    // heatStep -> canvas
  const paddleCache = new Map();  // width:state -> canvas
  let sigilCache = null, crackCache = null;

  const BW = 92, BH = 30, PAD = 14; // sim brick size + sprite padding

  function mkCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function shade(hex, f) {
    const n = parseInt(hex.slice(1), 16);
    const r = Math.min(255, Math.round(((n >> 16) & 255) * f));
    const g = Math.min(255, Math.round(((n >> 8) & 255) * f));
    const b = Math.min(255, Math.round((n & 255) * f));
    return 'rgb(' + r + ',' + g + ',' + b + ')';
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  function rr(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  /* Vector glyph emblems centered at (cx, cy), nominal size s. */
  function glyph(g, kind, cx, cy, s, color, alpha) {
    g.save();
    g.globalAlpha = alpha;
    if (kind === 'bolt' || kind === 'bolt2') {
      g.fillStyle = color;
      const bolt = (bx, bs) => {
        g.beginPath();
        const p = [[0.12, -1], [-0.48, 0.18], [-0.06, 0.18], [-0.12, 1], [0.48, -0.18], [0.06, -0.18]];
        p.forEach((pt, i) => {
          const X = bx + pt[0] * bs, Y = cy + pt[1] * bs * 1.12;
          if (i) g.lineTo(X, Y); else g.moveTo(X, Y);
        });
        g.closePath(); g.fill();
      };
      if (kind === 'bolt') bolt(cx, s);
      else { bolt(cx - s * 0.30, s * 0.72); bolt(cx + s * 0.30, s * 0.72); }
    } else if (kind === 'diamond') {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(cx, cy - s * 0.66); g.lineTo(cx + s * 0.48, cy);
      g.lineTo(cx, cy + s * 0.66); g.lineTo(cx - s * 0.48, cy);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(255,255,255,0.85)';
      g.beginPath();
      g.moveTo(cx, cy - s * 0.66); g.lineTo(cx + s * 0.48, cy); g.lineTo(cx, cy);
      g.closePath(); g.fill();
    } else if (kind === 'warn') {
      g.fillStyle = color;
      g.beginPath();
      g.moveTo(cx, cy - s * 0.58);
      g.lineTo(cx + s * 0.58, cy + s * 0.42);
      g.lineTo(cx - s * 0.58, cy + s * 0.42);
      g.closePath(); g.fill();
      g.fillStyle = 'rgba(24,2,2,0.62)';
      g.fillRect(cx - s * 0.06, cy - s * 0.30, s * 0.12, s * 0.38);
      g.beginPath(); g.arc(cx, cy + s * 0.24, s * 0.075, 0, 6.29); g.fill();
    }
    g.restore();
  }

  function bakeCracks(g, x, y, w, h) {
    g.strokeStyle = 'rgba(0,0,0,0.60)'; g.lineWidth = 1.6;
    const lines = [
      [[x + 10, y + 5], [x + 24, y + 13], [x + 33, y + 9], [x + 46, y + 19]],
      [[x + w - 12, y + 7], [x + w - 26, y + 15], [x + w - 38, y + 11]],
      [[x + w * 0.58, y + h - 5], [x + w * 0.52, y + h - 13], [x + w * 0.66, y + h - 19]],
    ];
    for (const L of lines) {
      g.beginPath();
      L.forEach((pt, i) => { if (i) g.lineTo(pt[0], pt[1]); else g.moveTo(pt[0], pt[1]); });
      g.stroke();
    }
    g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 1;
    g.beginPath();
    g.moveTo(x + 12, y + 7); g.lineTo(x + 26, y + 15);
    g.stroke();
  }

  function brickColors(theme, kind, hp, pal, diamond) {
    if (diamond) {
      return { top: '#3a2c22', mid: '#16121c', bot: '#060509',
               rim: '#ffb03a', rimDark: '#4a2410', glow: '#ff7a2b' };
    }
    if (kind === 'hazard') {
      const c = theme.palettes.hazard;
      return { top: shade(c, 1.30), mid: shade(c, 0.62), bot: shade(c, 0.28),
               rim: shade(c, 1.55), rimDark: shade(c, 0.32), glow: c };
    }
    if (kind === 'unbreakable') {
      const c = theme.palettes.unbreakable;
      return { top: shade(c, 1.18), mid: shade(c, 0.60), bot: shade(c, 0.30),
               rim: shade(c, 1.55), rimDark: '#101216', glow: null };
    }
    const c = theme.palettes.glass[pal % theme.palettes.glass.length];
    const depth = [0, 0.80, 0.62, 0.50][Math.min(hp, 3)]; // higher HP = deeper
    return { top: shade(c, Math.min(1.32, depth + 0.56)), mid: shade(c, depth),
             bot: shade(c, depth * 0.48), rim: shade(c, 1.5), rimDark: shade(c, 0.32), glow: c };
  }

  function makeBrickSprite(theme, kind, hp, pal) {
    const diamond = (kind === 'hazard' && (pal % 3) === 2);
    const C = brickColors(theme, kind, hp, pal, diamond);
    const c = mkCanvas(BW + PAD * 2, BH + PAD * 2);
    const g = c.getContext('2d');
    const x = PAD, y = PAD, w = BW, h = BH;
    // Body: vertical glass gradient.
    const bg = g.createLinearGradient(0, y, 0, y + h);
    bg.addColorStop(0, C.top); bg.addColorStop(0.45, C.mid); bg.addColorStop(1, C.bot);
    rr(g, x, y, w, h, 7);
    g.fillStyle = bg; g.fill();
    // Inner top glow wash.
    const ig = g.createLinearGradient(0, y, 0, y + h * 0.72);
    ig.addColorStop(0, 'rgba(255,255,255,0.32)');
    ig.addColorStop(1, 'rgba(255,255,255,0)');
    rr(g, x + 3, y + 3, w - 6, h - 6, 5);
    g.fillStyle = ig; g.fill();
    // Diagonal specular streak (upper-left), additive.
    g.save();
    rr(g, x, y, w, h, 7); g.clip();
    g.globalCompositeOperation = 'lighter';
    g.translate(x + w * 0.30, y + h * 0.10);
    g.rotate(-0.5);
    const sg = g.createLinearGradient(0, -h, 0, h);
    sg.addColorStop(0, 'rgba(255,255,255,0)');
    sg.addColorStop(0.5, 'rgba(255,255,255,0.30)');
    sg.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sg;
    g.fillRect(-w * 0.16, -h * 1.2, w * 0.32, h * 2.4);
    g.restore();
    // Specular spot, top-left.
    g.save();
    g.globalCompositeOperation = 'lighter';
    const sp = g.createRadialGradient(x + 21, y + 9, 1, x + 21, y + 9, 15);
    sp.addColorStop(0, 'rgba(255,255,255,0.75)');
    sp.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = sp;
    g.fillRect(x + 4, y - 7, 36, 32);
    g.restore();
    // Glyph emblem per type/HP.
    if (diamond) glyph(g, 'diamond', x + w / 2, y + h / 2, 13, '#ffb03a', 0.95);
    else if (kind === 'hazard') glyph(g, 'warn', x + w / 2, y + h / 2, 11, '#ffffff', 0.92);
    else if (kind === 'unbreakable') {
      g.save();
      rr(g, x, y, w, h, 7); g.clip();
      g.strokeStyle = 'rgba(255,255,255,0.20)'; g.lineWidth = 2;
      g.beginPath();
      for (let lx = x - h; lx < x + w + h; lx += 13) {
        g.moveTo(lx, y + h); g.lineTo(lx + h, y);
      }
      g.stroke();
      g.restore();
    } else if (hp >= 3) {
      glyph(g, 'bolt', x + w / 2, y + h / 2, 10, '#ffffff', 0.92);
      bakeCracks(g, x, y, w, h);
    } else if (hp === 2) glyph(g, 'bolt2', x + w / 2, y + h / 2, 10, '#ffffff', 0.90);
    else glyph(g, 'bolt', x + w / 2, y + h / 2, 9, '#ffffff', 0.85);
    // Inner bottom AO.
    g.save();
    rr(g, x + 2, y + 2, w - 4, h - 4, 6); g.clip();
    const ao = g.createLinearGradient(0, y + h - 12, 0, y + h);
    ao.addColorStop(0, 'rgba(0,0,0,0)');
    ao.addColorStop(1, 'rgba(0,0,0,0.44)');
    g.fillStyle = ao;
    g.fillRect(x, y + h - 12, w, 12);
    g.restore();
    // Directional rim: top+left lit (key azimuth), bottom+right shadow.
    rr(g, x + 1, y + 1, w - 2, h - 2, 6);
    g.strokeStyle = C.rimDark; g.globalAlpha = 0.85; g.lineWidth = 2; g.stroke();
    g.strokeStyle = C.rim; g.globalAlpha = 0.95;
    g.beginPath();
    g.moveTo(x + 7, y + h - 1);
    g.lineTo(x + 7, y + 8);
    g.quadraticCurveTo(x + 7, y + 1, x + 13, y + 1);
    g.lineTo(x + w - 9, y + 1);
    g.stroke();
    g.globalAlpha = 1;
    return c;
  }

  function makeCrackOverlay() {
    const c = mkCanvas(BW, BH);
    const g = c.getContext('2d');
    bakeCracks(g, 0, 0, BW, BH);
    return c;
  }

  function makeSigil() {
    const c = mkCanvas(30, 30);
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(15, 15, 2, 15, 15, 15);
    gr.addColorStop(0, hexA('#ffd34d', 0.85));
    gr.addColorStop(1, hexA('#ffd34d', 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 30, 30);
    glyph(g, 'diamond', 15, 15, 9, '#ffe9a8', 1);
    return c;
  }

  /* Plasma ball: white-hot core -> colored corona -> outer glow disc.
     8 heat steps; heat shifts the corona toward the trail palette. */
  function makeBallSprite(theme, step) {
    const f = step / 7;
    const corona = f < 0.5 ? theme.ball.corona : theme.ball.trailA;
    const c = mkCanvas(72, 72);
    const g = c.getContext('2d');
    const cx = 36, cy = 36;
    let gr = g.createRadialGradient(cx, cy, 4, cx, cy, 34);
    gr.addColorStop(0, hexA(corona, 0.50));
    gr.addColorStop(0.5, hexA(corona, 0.20));
    gr.addColorStop(1, hexA(corona, 0));
    g.fillStyle = gr;
    g.fillRect(0, 0, 72, 72);
    gr = g.createRadialGradient(cx, cy, 1, cx, cy, 15);
    gr.addColorStop(0, '#ffffff');
    gr.addColorStop(0.45, corona);
    gr.addColorStop(1, hexA(corona, 0.06));
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, 15, 0, 6.29); g.fill();
    gr = g.createRadialGradient(cx - 2, cy - 2, 0.5, cx, cy, 9);
    gr.addColorStop(0, '#ffffff');
    gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr;
    g.beginPath(); g.arc(cx, cy, 9, 0, 6.29); g.fill();
    g.fillStyle = 'rgba(255,255,255,0.95)';
    g.beginPath(); g.arc(cx - 5, cy - 6, 3, 0, 6.29); g.fill();
    return c;
  }

  /* Paddle light-bar: metallic base, key-lit top edge, neon core housing,
     beveled end caps, optional laser cannons. The core strip flow stays
     per-frame (animated) inside the baked housing. */
  function makePaddleSprite(theme, width, state) {
    const px = 18, py = 24, h = 22;
    const c = mkCanvas(Math.round(width) + px * 2, h + py * 2);
    const g = c.getContext('2d');
    const x = px, y = py, w = Math.round(width);
    const base = theme.paddle.base, strip = theme.paddle.coreStrip, cap = theme.paddle.cap;
    const bg = g.createLinearGradient(0, y, 0, y + h);
    bg.addColorStop(0, shade(base, 1.7));
    bg.addColorStop(0.5, shade(base, 0.9));
    bg.addColorStop(1, shade(base, 0.45));
    rr(g, x, y, w, h, 10);
    g.fillStyle = bg; g.fill();
    g.save();
    g.globalCompositeOperation = 'lighter';
    const ke = g.createLinearGradient(0, y, 0, y + 7);
    ke.addColorStop(0, 'rgba(255,255,255,0.80)');
    ke.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = ke;
    g.fillRect(x + 8, y + 1, w - 16, 6);
    g.restore();
    rr(g, x + 10, y + 6, w - 20, h - 12, 5);
    g.fillStyle = 'rgba(0,0,0,0.55)'; g.fill();
    g.strokeStyle = hexA(strip, 0.55); g.lineWidth = 1.5; g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.60)'; g.lineWidth = 2;
    g.beginPath();
    g.moveTo(x + 10, y + h - 2); g.lineTo(x + w - 10, y + h - 2);
    g.stroke();
    for (const sgn of [-1, 1]) {
      const cxp = sgn < 0 ? x - 3 : x + w - 11;
      const cg = g.createLinearGradient(0, y + 2, 0, y + h - 2);
      cg.addColorStop(0, shade(cap, 1.30));
      cg.addColorStop(0.5, cap);
      cg.addColorStop(1, shade(cap, 0.55));
      rr(g, cxp, y + 2, 14, h - 4, 6);
      g.fillStyle = cg; g.fill();
      g.strokeStyle = 'rgba(255,255,255,0.70)'; g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(cxp + 3, y + 4); g.lineTo(cxp + 11, y + 4);
      g.stroke();
    }
    if (state === 'laser') {
      const off = w / 2 - 16;
      for (const sgn of [-1, 1]) {
        const bx = x + w / 2 + sgn * off - 5;
        const cg2 = g.createLinearGradient(0, y - 16, 0, y);
        cg2.addColorStop(0, '#3a4158');
        cg2.addColorStop(1, '#1a1e30');
        rr(g, bx, y - 16, 10, 18, 3);
        g.fillStyle = cg2; g.fill();
        g.strokeStyle = hexA(strip, 0.60); g.lineWidth = 1; g.stroke();
      }
    }
    return c;
  }

  function warm(theme, name) {
    themeName = name;
    curTheme = theme;
    brickCache.clear(); ballCache.clear(); paddleCache.clear();
    sigilCache = null; crackCache = null;
    for (const kind of ['glass', 'hazard', 'unbreakable']) {
      for (let hp = 1; hp <= 3; hp++) {
        for (let pal = 0; pal < 3; pal++) {
          brickCache.set(kind + ':' + hp + ':' + pal, makeBrickSprite(theme, kind, hp, pal));
        }
      }
    }
    for (let i = 0; i < 8; i++) ballCache.set(i, makeBallSprite(theme, i));
    paddleCache.set('150:normal', makePaddleSprite(theme, 150, 'normal'));
    paddleCache.set('150:laser', makePaddleSprite(theme, 150, 'laser'));
    paddleCache.set('225:wide', makePaddleSprite(theme, 225, 'wide'));
    sigilCache = makeSigil();
    crackCache = makeCrackOverlay();
  }

  function brick(theme, kind, hp, pal) {
    const key = kind + ':' + Math.min(hp, 3) + ':' + (pal % 3);
    let s = brickCache.get(key);
    if (!s) { s = makeBrickSprite(theme, kind, hp, pal); brickCache.set(key, s); }
    const diamond = (kind === 'hazard' && (pal % 3) === 2);
    const glow = diamond ? '#ff7a2b'
      : kind === 'hazard' ? theme.palettes.hazard
      : kind === 'unbreakable' ? null
      : theme.palettes.glass[pal % theme.palettes.glass.length];
    return { sprite: s, glow, diamond };
  }

  function ballHeat(theme, heat) {
    // 8 heat steps, white -> corona -> orange.
    const i = Math.max(0, Math.min(7, Math.round(heat * 7)));
    const f = i / 7;
    return { step: i, corona: f < 0.5 ? theme.ball.corona : theme.ball.trailA,
             trail: f < 0.5 ? theme.ball.trailA : theme.ball.trailB };
  }

  function ballSprite(step) {
    let s = ballCache.get(step);
    if (!s && curTheme) { s = makeBallSprite(curTheme, step); ballCache.set(step, s); }
    return s;
  }

  function paddleSprite(width, state) {
    const key = Math.round(width) + ':' + state;
    let s = paddleCache.get(key);
    if (!s && curTheme) { s = makePaddleSprite(curTheme, width, state); paddleCache.set(key, s); }
    return s;
  }

  function sigil() { return sigilCache; }
  function cracks() { return crackCache; }

  /* Power-core carrier marker: deterministic hash over brick position —
     ~12% of glass bricks get the sigil. Visual-only rarity marker; the
     actual core drop stays sim-random (renderer never reads sim logic). */
  function isCarrier(x, y) {
    let h = Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663);
    h = (h ^ (h >>> 13)) >>> 0;
    return (h % 100) < 12;
  }

  function core(theme, kind) {
    return { color: theme.cores[kind] || '#ffffff' };
  }

  function paddle(theme, state) {
    return { base: theme.paddle.base, strip: theme.paddle.coreStrip,
             cap: theme.paddle.cap, glow: theme.paddle.glow, state };
  }

  return { warm, brick, ballHeat, ballSprite, paddleSprite, sigil, cracks,
           isCarrier, core, paddle, shade, themeName: () => themeName };
})();

/* ---------------- VisualDirector ----------------
   Render-side only. Consumes sim events, spawns visual entities.
   Never read by the sim. */
NB.VD = (() => {
  function create() {
    return {
      time: 0, particles: [], waves: [], flashes: [], floaters: [], rays: [], embers: [],
      trails: new Map(), shake: 0, flash: 0, redPulse: 0,
      motes: [], moteT: 0, emberT: 0, paddleHist: [],
      paddleFlash: 0, paddleFlashX: 960,
    };
  }

  // C5: particles carry a shape: 'dot' | 'shard' (rotated polygon) |
  // 'streak' (velocity-aligned line). Shards drift gravity-less (space
  // feel); streaks read as plasma sparks.
  function spawnBurst(vd, x, y, colors, n, speed, size, life, opts) {
    const budget = vd.budget || 600;
    const shape = (opts && opts.shape) || 'dot';
    for (let i = 0; i < n && vd.particles.length < budget; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.3 + Math.random() * 0.9);
      vd.particles.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        t: 0, life: life * (0.6 + Math.random() * 0.7),
        size: size * (0.6 + Math.random() * 0.8),
        color: colors[(Math.random() * colors.length) | 0],
        shape,
        rot: Math.random() * 6.283,
        vr: (Math.random() - 0.5) * 12,
      });
    }
  }

  function floater(vd, x, y, text, color, size) {
    if (vd.floaters.length > 24) vd.floaters.shift();
    vd.floaters.push({ x, y, text, color, size: size || 26, t: 0, life: 1.15 });
  }

  const CORE_LABELS = { multi: '#39e6c3', wide: '#4da3ff', laser: '#ff9a3d', slow: '#b06bff', hull: '#ffd34d' };

  function update(vd, events, view, theme, realDt, quality) {
    vd.time += realDt;
    vd.budget = quality === 'full' ? 600 : quality === 'reduced' ? 300 : 150;
    let shatters = 0, lastSX = 960, lastSY = 480;

    for (const e of events) {
      switch (e.t) {
        case 'brickShattered': {
          shatters++;
          lastSX = e.x; lastSY = e.y;
          // C5: faceted shards + plasma streak sparks + impact flash pop.
          spawnBurst(vd, e.x, e.y, theme.explosion.shards, 24, 480, 7, 1.05, { shape: 'shard' });
          spawnBurst(vd, e.x, e.y, ['#ffffff', theme.explosion.ring], 12, 560, 3.5, 0.55, { shape: 'streak' });
          spawnBurst(vd, e.x, e.y, ['#ffffff'], 8, 260, 3, 0.5);
          vd.flashes.push({ x: e.x, y: e.y, t: 0, life: 0.28, color: '#fff2d0', r: 52 });
          if (vd.flashes.length > 10) vd.flashes.shift();
          // Laser-bolt impacts read as hot orange strikes.
          if (view.shots.some(s => Math.abs(s.x - e.x) < 70 && Math.abs(s.y - e.y) < 130)) {
            spawnBurst(vd, e.x, e.y, ['#ff9a3d', '#ffd34d', '#ffffff'], 10, 420, 4, 0.5, { shape: 'streak' });
          }
          vd.waves.push({ x: e.x, y: e.y, r: 12, vr: 780, t: 0, life: 0.7, color: theme.explosion.ring });
          floater(vd, e.x, e.y - 18, '+' + (100 * (e.hp || 1) * (view.hud.multiplier || 1)), theme.hud.cyan, 24);
          vd.shake = Math.min(vd.shake + (e.hp >= 3 ? 9 : 5), 24);
          break;
        }
        case 'brickHit':
          spawnBurst(vd, e.x, e.y, ['#ffffff', theme.explosion.ring], 6, 200, 3, 0.4, { shape: 'streak' });
          if (view.shots.some(s => Math.abs(s.x - e.x) < 70 && Math.abs(s.y - e.y) < 130)) {
            spawnBurst(vd, e.x, e.y, ['#ff9a3d', '#ffffff'], 6, 340, 3, 0.4, { shape: 'streak' });
          }
          break;
        case 'paddleHit':
          // C5: bounce impact flash on the paddle + spark spray.
          spawnBurst(vd, e.x, e.y, [theme.paddle.glow, '#ffffff'], 5, 180, 3, 0.35);
          spawnBurst(vd, e.x, e.y, ['#ffffff', theme.paddle.glow], 4, 320, 3, 0.3, { shape: 'streak' });
          vd.paddleFlash = 1; vd.paddleFlashX = e.x;
          break;
        case 'wallHit':
          spawnBurst(vd, e.x, e.y, ['#ffffff'], 3, 120, 2, 0.3);
          break;
        case 'ballLaunched':
          spawnBurst(vd, e.x, e.y, [theme.ball.corona], 10, 220, 3, 0.5);
          break;
        case 'coreCaught':
          spawnBurst(vd, view.paddle.x, 812, [CORE_LABELS[e.kind] || '#ffffff'], 16, 300, 4, 0.7);
          floater(vd, view.paddle.x, 760, e.label || '', CORE_LABELS[e.kind] || '#ffffff', 30);
          vd.shake = Math.min(vd.shake + 4, 24);
          break;
        case 'coreMissed':
          spawnBurst(vd, e.x, e.y, ['#8899aa'], 5, 120, 2, 0.4);
          break;
        case 'coreSpawned':
          spawnBurst(vd, e.x, e.y, [theme.cores[e.kind] || '#ffffff'], 6, 120, 3, 0.5);
          break;
        case 'multiplierUp':
          floater(vd, 960, 420, e.mult + 'x COMBO', theme.hud.gold, 44);
          vd.waves.push({ x: 960, y: 420, r: 20, vr: 500, t: 0, life: 0.9, color: theme.hud.gold });
          vd.rays.push({ x: 960, y: 420, t: 0, life: 1.2, n: 12, color: theme.hud.gold });
          break;
        case 'scorePop':
          floater(vd, e.x, e.y - 14, e.text, theme.hud.cyan, 22);
          break;
        case 'hullLost':
          vd.redPulse = 1;
          vd.shake = Math.min(vd.shake + 14, 26);
          floater(vd, 960, 700, 'HULL BREACH', theme.hud.red, 40);
          break;
        case 'laserFired':
          spawnBurst(vd, e.x - 40, e.y, ['#ff9a3d'], 3, 140, 2, 0.25);
          spawnBurst(vd, e.x + 40, e.y, ['#ff9a3d'], 3, 140, 2, 0.25);
          break;
        case 'clearBeat':
          vd.flash = Math.max(vd.flash, 0.35);
          break;
        case 'sectorCleared':
          vd.flash = Math.max(vd.flash, 0.65);
          vd.waves.push({ x: 960, y: 510, r: 40, vr: 1400, t: 0, life: 1.2, color: theme.hud.gold });
          vd.rays.push({ x: 960, y: 510, t: 0, life: 1.5, n: 16, color: '#ffffff' });
          floater(vd, 960, 480, 'SECTOR CLEAR', theme.hud.gold, 52);
          break;
        case 'gameOver':
          vd.redPulse = 0.7;
          break;
      }
    }
    if (shatters >= 3) { // bigBreak: 3+ bricks in one frame
      vd.flash = Math.max(vd.flash, 0.42);
      vd.shake = Math.min(vd.shake + 8, 26);
      vd.rays.push({ x: lastSX, y: lastSY, t: 0, life: 1.0, n: 8, color: theme.explosion.ring });
    }

    // Trails follow balls by id. C5: speed-reactive — each point stores
    // its instantaneous speed; fast balls keep a long bright ribbon,
    // slow balls a short faint one. Points age out when the cap shrinks.
    const baseCap = quality === 'full' ? 24 : quality === 'reduced' ? 12 : 8;
    const seen = new Set();
    for (const b of view.balls) {
      seen.add(b.id);
      let tr = vd.trails.get(b.id);
      if (!tr) { tr = []; vd.trails.set(b.id, tr); }
      const last = tr[tr.length - 1];
      const v = (last && realDt > 0)
        ? Math.hypot(b.x - last.x, b.y - last.y) / realDt : 0;
      tr.push({ x: b.x, y: b.y, v });
      const cap = quality === 'full'
        ? Math.max(6, Math.round(baseCap * Math.min(1, v / 900)))
        : baseCap;
      while (tr.length > cap) tr.shift();
      // C5: ball spark droplets shed by fast balls (heat-tinted).
      if (v > 750 && vd.particles.length < vd.budget * 0.75 && Math.random() < 0.55) {
        vd.particles.push({
          x: b.x + (Math.random() - 0.5) * 10, y: b.y + (Math.random() - 0.5) * 10,
          vx: (Math.random() - 0.5) * 130, vy: (Math.random() - 0.5) * 130,
          t: 0, life: 0.32 + Math.random() * 0.15,
          size: 2 + Math.random() * 2.2,
          color: Math.random() < 0.4 ? '#ffffff' : (theme.ball.corona || '#ffcf6e'),
          shape: 'dot', rot: 0, vr: 0,
        });
      }
    }
    for (const id of [...vd.trails.keys()]) if (!seen.has(id)) vd.trails.delete(id);

    // Particles / waves / floaters integrate (render time).
    for (const pt of vd.particles) {
      pt.t += realDt;
      pt.x += pt.vx * realDt; pt.y += pt.vy * realDt;
      pt.vx *= (1 - 1.6 * realDt); pt.vy *= (1 - 1.6 * realDt);
    }
    vd.particles = vd.particles.filter(p => p.t < p.life);
    for (const w of vd.waves) { w.t += realDt; w.r += w.vr * realDt; }
    vd.waves = vd.waves.filter(w => w.t < w.life && vd.waves.length < 8);
    for (const r of vd.rays) r.t += realDt;
    vd.rays = vd.rays.filter(r => r.t < r.life);
    for (const f of vd.floaters) { f.t += realDt; f.y -= 52 * realDt; }
    vd.floaters = vd.floaters.filter(f => f.t < f.life);
    // Impact flash pops (C5): quick additive discs on every shatter.
    for (const f of vd.flashes) f.t += realDt;
    vd.flashes = vd.flashes.filter(f => f.t < f.life);
    // Paddle bounce flash decay (C5).
    vd.paddleFlash = Math.max(0, vd.paddleFlash - realDt * 3.2);

    // Ambient motes drifting in the arena (12 max).
    vd.moteT -= realDt;
    if (vd.moteT <= 0 && vd.motes.length < 12) {
      vd.moteT = 0.5;
      vd.motes.push({ x: 360 + Math.random() * 1200, y: 140 + Math.random() * 740,
                      vx: (Math.random() - 0.5) * 24, vy: -8 - Math.random() * 18,
                      t: 0, life: 6 + Math.random() * 6, r: 1 + Math.random() * 2 });
    }
    for (const m of vd.motes) { m.t += realDt; m.x += m.vx * realDt; m.y += m.vy * realDt; }
    vd.motes = vd.motes.filter(m => m.t < m.life);
    // Ember drift (C3): rising ambient particles, Ember Drift + Abyssal Teal.
    // C2-fix: denser, brighter drift so the warm/cool fields carry
    // luminous density in the blur.
    const emberTheme = theme.name === 'Ember Drift';
    const sporeTheme = theme.name === 'Abyssal Teal';
    if (emberTheme || sporeTheme) {
      vd.emberT -= realDt;
      const cap = emberTheme ? 72 : 34;
      if (vd.emberT <= 0 && vd.embers.length < cap) {
        vd.emberT = emberTheme ? 0.07 : 0.16;
        vd.embers.push({
          x: Math.random() * 1920, y: 1090,
          vx: (Math.random() - 0.5) * 30, vy: -(28 + Math.random() * 70),
          t: 0, life: 4 + Math.random() * 4,
          size: 1 + Math.random() * (emberTheme ? 2.6 : 2),
          color: emberTheme
            ? ['#ffb03a', '#ff7a2b', '#ffd34d', '#ff4d3d'][(Math.random() * 4) | 0]
            : ['#5ce6b0', '#39e6c3'][(Math.random() * 2) | 0],
          ph: Math.random() * 6.28,
        });
      }
    }
    for (const e of vd.embers) {
      e.t += realDt;
      e.y += e.vy * realDt;
      e.x += (e.vx + Math.sin(vd.time * 1.7 + e.ph) * 22) * realDt;
    }
    vd.embers = vd.embers.filter(e => e.t < e.life && e.y > -20);
    // Paddle motion history for the smear (C3): keep last ~0.3s.
    vd.paddleHist.push({ x: view.paddle.x, age: 0 });
    for (const h of vd.paddleHist) h.age += realDt;
    while (vd.paddleHist.length && (vd.paddleHist[0].age > 0.3 || vd.paddleHist.length > 20)) {
      vd.paddleHist.shift();
    }

    vd.shake *= Math.exp(-6.5 * realDt);
    if (vd.shake < 0.15) vd.shake = 0;
    vd.flash = Math.max(0, vd.flash - realDt * 1.0);
    vd.redPulse = Math.max(0, vd.redPulse - realDt * 0.9);
  }

  return { create, update };
})();

/* ---------------- Renderer ---------------- */
NB.Renderer = (() => {
  const W = 1920, H = 1080;
  let canvas, ctx, dpr = 1;
  let theme = null, themeKey = '';
  let bgCache = null, bgNearStars = [];
  let arenaCache = null, vigCache = null, redVigCache = null, grainPat = null, curveCache = null;
  let aoCache = null; // soft dark ellipse sprite for contact AO
  let bloomC = null, bctx = null, bloomScale = 0.25;
  const glowCache = new Map(); // color -> radial sprite canvas
  let quality = 'full';

  const FONT = (s, w) => 'italic ' + (w || 900) + ' ' + s + 'px "Arial Black","Helvetica Neue",Arial,sans-serif';

  function makeCanvas(w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function glowSprite(color) {
    let c = glowCache.get(color);
    if (!c) {
      c = makeCanvas(128, 128);
      const g = c.getContext('2d');
      const gr = g.createRadialGradient(64, 64, 2, 64, 64, 64);
      gr.addColorStop(0, color);
      gr.addColorStop(0.35, color + 'aa');
      gr.addColorStop(1, color + '00');
      g.fillStyle = gr;
      g.fillRect(0, 0, 128, 128);
      glowCache.set(color, c);
    }
    return c;
  }

  function init(c) {
    canvas = c;
    ctx = c.getContext('2d');
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const bs = quality === 'full' ? 0.25 : 0.125;
    bloomScale = bs;
    bloomC = makeCanvas(Math.round(W * bs), Math.round(H * bs));
    bctx = bloomC.getContext('2d');
    // AO sprite: soft dark radial ellipse, theme-independent.
    aoCache = makeCanvas(128, 64);
    const ag = aoCache.getContext('2d');
    ag.save();
    ag.translate(64, 32);
    ag.scale(2, 1);
    const ar = ag.createRadialGradient(0, 0, 4, 0, 0, 30);
    ar.addColorStop(0, 'rgba(0,0,0,0.6)');
    ar.addColorStop(1, 'rgba(0,0,0,0)');
    ag.fillStyle = ar;
    ag.beginPath(); ag.arc(0, 0, 30, 0, 6.29); ag.fill();
    ag.restore();
  }

  function setQuality(q) {
    quality = q;
    const bs = q === 'full' ? 0.25 : 0.125;
    if (bs !== bloomScale) {
      bloomScale = bs;
      bloomC = makeCanvas(Math.round(W * bs), Math.round(H * bs));
      bctx = bloomC.getContext('2d');
    }
  }

  function setTheme(t, key) {
    theme = t; themeKey = key;
    glowCache.clear();
    NB.Materials.warm(t, key);
    buildBgCache();
    buildArenaCache();
    buildGradeCaches();
  }

  function buildBgCache() {
    const cw = 1960, ch = 1120;
    bgCache = makeCanvas(cw, ch);
    const g = bgCache.getContext('2d');
    const base = g.createLinearGradient(0, 0, 0, ch);
    const stops = theme.bg.baseStops;
    stops.forEach((s, i) => base.addColorStop(i / (stops.length - 1), s));
    g.fillStyle = base;
    g.fillRect(0, 0, cw, ch);
    // C3 density: per-theme background props (seeded, deterministic).
    const rng = mulberry32(themeSeed(themeKey));
    const prop = theme.bg.prop;
    if (prop === 'facets') bgFacets(g, cw, ch, rng);
    else if (prop === 'streaks') bgStreaks(g, cw, ch, rng);
    else if (prop === 'smoke') bgSmoke(g, cw, ch, rng);
    // Nebula blobs (additive).
    g.globalCompositeOperation = 'lighter';
    for (const n of theme.bg.nebula) {
      const gr = g.createRadialGradient(n.x * cw, n.y * ch, 10, n.x * cw, n.y * ch, n.r);
      const col = n.color;
      gr.addColorStop(0, hexA(col, n.a));
      gr.addColorStop(1, hexA(col, 0));
      g.fillStyle = gr;
      g.fillRect(n.x * cw - n.r, n.y * ch - n.r, n.r * 2, n.r * 2);
    }
    // Key-light wash (C2-fix: per-theme strength, carries light direction).
    const k = theme.keyLight;
    const kg = g.createRadialGradient(k.x * (cw / W), k.y * (ch / H), 20,
                                      k.x * (cw / W), k.y * (ch / H), k.r);
    kg.addColorStop(0, hexA(k.color, k.a || 0.22));
    kg.addColorStop(1, hexA(k.color, 0));
    g.fillStyle = kg;
    g.fillRect(0, 0, cw, ch);
    g.globalCompositeOperation = 'source-over';
    // C2-fix: bright luminous border wash — transparent at the frame
    // center, bright at the edges (screen blend). This is the value
    // structure the refs show: bright edges, luminous field filling
    // the frame, arena slightly darker than its surroundings.
    if (theme.edgeGlow) {
      const egr = g.createRadialGradient(cw / 2, ch / 2, Math.min(cw, ch) * 0.30,
                                         cw / 2, ch / 2, Math.max(cw, ch) * 0.72);
      egr.addColorStop(0, hexA(theme.edgeGlow.color, 0));
      egr.addColorStop(1, hexA(theme.edgeGlow.color, theme.edgeGlow.a));
      g.globalCompositeOperation = 'screen';
      g.fillStyle = egr;
      g.fillRect(0, 0, cw, ch);
      g.globalCompositeOperation = 'source-over';
    }
    // Abyssal light ribbons sit above the nebula wash (luminous, additive).
    if (prop === 'ribbons') bgRibbons(g, cw, ch, rng);
    // Fog / depth: vertical fog gradient (denser toward the top) + edge
    // darkening so the frame reads deeper at the borders (LOOK.md C1).
    const fog = theme.fog;
    const fg = g.createLinearGradient(0, 0, 0, ch);
    fg.addColorStop(0, hexA(fog.color, fog.a));
    fg.addColorStop(0.55, hexA(fog.color, fog.a * 0.35));
    fg.addColorStop(1, hexA(fog.color, 0));
    g.fillStyle = fg;
    g.fillRect(0, 0, cw, ch);
    const edge = g.createLinearGradient(0, 0, cw, 0);
    // C2-fix: edge darkening halved so the frame reads luminous
    // edge-to-edge instead of a dark border vignette in the blur.
    edge.addColorStop(0, 'rgba(0,0,0,0.14)');
    edge.addColorStop(0.14, 'rgba(0,0,0,0)');
    edge.addColorStop(0.86, 'rgba(0,0,0,0)');
    edge.addColorStop(1, 'rgba(0,0,0,0.14)');
    g.fillStyle = edge;
    g.fillRect(0, 0, cw, ch);
    // Starfield layers (far 220 / mid 120 baked; near 60 twinkle per-frame).
    const layers = [
      { n: 220, r: 1.0, a: 0.45 }, { n: 120, r: 1.6, a: 0.7 },
    ];
    g.fillStyle = theme.bg.starTint;
    for (const L of layers) {
      g.globalAlpha = L.a;
      for (let i = 0; i < L.n; i++) {
        const x = rng() * cw, y = rng() * ch;
        g.fillRect(x, y, L.r, L.r);
      }
    }
    g.globalAlpha = 1;
    // Ambient / IBL-style fill: cool sky tint from the top, deep ground
    // tint at the bottom. Keeps shadows saturated, never black (LOOK.md).
    const amb = theme.ambient;
    g.globalCompositeOperation = 'lighter';
    const sky = g.createLinearGradient(0, 0, 0, ch * 0.6);
    sky.addColorStop(0, hexA(amb.sky, amb.skyA));
    sky.addColorStop(1, hexA(amb.sky, 0));
    g.fillStyle = sky;
    g.fillRect(0, 0, cw, ch * 0.6);
    g.globalCompositeOperation = 'source-over';
    const grd = g.createLinearGradient(0, ch * 0.45, 0, ch);
    grd.addColorStop(0, hexA(amb.ground, 0));
    grd.addColorStop(1, hexA(amb.ground, amb.groundA));
    g.fillStyle = grd;
    g.fillRect(0, ch * 0.45, cw, ch * 0.55);
    bgNearStars = [];
    for (let i = 0; i < 60; i++) {
      bgNearStars.push({ x: rng() * cw, y: rng() * ch,
                         ph: rng() * 6.28, r: 1.4 + rng() * 1.2 });
    }
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }

  /* Seeded RNG so background props are stable per theme (no per-run flicker). */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function themeSeed(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) { h ^= key.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* C3 background props — per-theme density behind the play field. */
  function bgFacets(g, cw, ch, rng) { // violet: crystalline facet polygons
    // C2-fix: richer luminous density — more facets, higher value, more
    // lit ones so the violet crystal field carries the blur structure.
    const cols = ['#2c1854', '#46227e', '#5f30ad', '#7d3fd4', '#1c0f3d'];
    for (let i = 0; i < 48; i++) {
      const cx = rng() * cw, cy = rng() * ch;
      const r = 130 + rng() * 300;
      const n = 3 + Math.floor(rng() * 3);
      const a0 = rng() * 6.28;
      g.beginPath();
      for (let k = 0; k < n; k++) {
        const a = a0 + (k / n) * 6.28 + (rng() - 0.5) * 0.5;
        const rr2 = r * (0.7 + rng() * 0.5);
        const px = cx + Math.cos(a) * rr2, py = cy + Math.sin(a) * rr2 * 0.8;
        if (k) g.lineTo(px, py); else g.moveTo(px, py);
      }
      g.closePath();
      if (rng() < 0.30) g.fillStyle = 'rgba(238,220,255,0.72)';
      else g.fillStyle = hexA(cols[(rng() * cols.length) | 0], 0.72);
      g.fill();
      if (rng() < 0.55) {
        g.strokeStyle = 'rgba(215,180,255,0.45)';
        g.lineWidth = 2;
        g.stroke();
      }
    }
  }

  function bgRibbons(g, cw, ch, rng) { // abyssal: swooping light ribbons
    // C2-fix: richer luminous density — more, brighter ribbons so the
    // teal field fills the frame in the blur.
    g.save();
    g.globalCompositeOperation = 'lighter';
    const cols = ['#1f9a78', '#35e0b4', '#147a5e', '#48f0cc'];
    for (let i = 0; i < 13; i++) {
      const y0 = rng() * ch;
      const col = cols[(rng() * cols.length) | 0];
      const wdt = 46 + rng() * 110;
      g.beginPath();
      g.moveTo(-80, y0);
      g.bezierCurveTo(cw * 0.3, y0 + (rng() - 0.5) * 500,
                      cw * 0.7, y0 + (rng() - 0.5) * 500,
                      cw + 80, y0 + (rng() - 0.5) * 300);
      g.strokeStyle = hexA(col, 0.16 + rng() * 0.12);
      g.lineWidth = wdt;
      g.stroke();
      g.strokeStyle = hexA('#d8ffe9', 0.24 + rng() * 0.14);
      g.lineWidth = 6 + rng() * 10;
      g.stroke();
    }
    g.restore();
  }

  function bgStreaks(g, cw, ch, rng) { // glacier: industrial light streaks
    // C2-fix: brightly lit industrial interior — machinery reads as
    // lit mid-gray structures, not near-black silhouettes; more,
    // brighter streaks.
    for (let i = 0; i < 6; i++) { // lit machinery structures
      const mw = 120 + rng() * 260, mh = 60 + rng() * 160;
      const mx = rng() * cw, my = rng() * ch * 0.8;
      g.fillStyle = 'rgba(56,70,94,0.88)';
      g.fillRect(mx, my, mw, mh);
      g.strokeStyle = 'rgba(150,205,255,0.40)';
      g.lineWidth = 2;
      g.strokeRect(mx, my, mw, mh);
      g.fillStyle = 'rgba(190,225,255,0.16)';
      g.fillRect(mx, my, mw, 8); // top light catch
    }
    g.save();
    g.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 34; i++) { // thin light streaks
      const x0 = rng() * cw, y0 = rng() * ch;
      const len = 90 + rng() * 340, ang = (rng() - 0.5) * 0.35;
      const bright = rng() < 0.35;
      g.strokeStyle = bright ? 'rgba(235,248,255,0.52)'
                            : 'rgba(180,215,250,' + (0.12 + rng() * 0.18).toFixed(3) + ')';
      g.lineWidth = bright ? 3.5 : 1 + rng() * 1.6;
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x0 + Math.cos(ang) * len, y0 + Math.sin(ang) * len);
      g.stroke();
    }
    g.restore();
  }

  function bgSmoke(g, cw, ch, rng) { // ember: heavy smoke + silhouettes
    // C2-fix: warm amber wash at higher value — glowing haze plumes,
    // softened silhouettes with lit rims.
    g.save();
    for (let i = 0; i < 8; i++) { // warm haze plumes across the frame
      const sx = rng() * cw, sy = ch * 0.30 + rng() * ch * 0.65;
      const sr = 220 + rng() * 280;
      const gr = g.createRadialGradient(sx, sy, 10, sx, sy, sr);
      gr.addColorStop(0, 'rgba(205,110,48,0.46)');
      gr.addColorStop(1, 'rgba(205,110,48,0)');
      g.fillStyle = gr;
      g.fillRect(sx - sr, sy - sr, sr * 2, sr * 2);
    }
    for (let i = 0; i < 5; i++) { // industrial silhouettes, bottom edge
      const mw = 180 + rng() * 320, mh = 90 + rng() * 170;
      const mx = rng() * cw, my = ch - mh;
      g.fillStyle = 'rgba(38,17,7,0.58)';
      g.fillRect(mx, my, mw, mh);
      g.fillStyle = 'rgba(255,178,100,0.50)';
      g.fillRect(mx, my, mw, 4);
    }
    g.restore();
  }

  function buildArenaCache() {
    const A = { x: 360, y: 140, w: 1200, h: 740 };
    arenaCache = makeCanvas(A.w, A.h);
    const g = arenaCache.getContext('2d');
    const inner = g.createLinearGradient(0, 0, 0, A.h);
    // C2-fix: the inner court was near-black navy, dominating the blur as
    // a dark centered arena. Now a luminous theme-tinted field so the
    // background reads as one continuous lit environment.
    const af = theme.arenaField || ['#101430', '#181c40', '#101430'];
    inner.addColorStop(0, hexA(af[0], 0.94));
    inner.addColorStop(0.5, hexA(af[1], 0.90));
    inner.addColorStop(1, hexA(af[0], 0.94));
    g.fillStyle = inner;
    g.fillRect(0, 0, A.w, A.h);
    // Arena depth haze: lightened so the brick field stays luminous.
    const ah = g.createLinearGradient(0, 0, 0, A.h * 0.5);
    ah.addColorStop(0, 'rgba(0,0,0,0.12)');
    ah.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = ah;
    g.fillRect(0, 0, A.w, A.h * 0.5);
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = hexA(theme.keyLight.color, 0.045);
    g.fillRect(0, 0, A.w, A.h);
    g.globalCompositeOperation = 'source-over';
    const ab = g.createLinearGradient(0, A.h * 0.55, 0, A.h);
    ab.addColorStop(0, 'rgba(0,0,0,0)');
    ab.addColorStop(1, 'rgba(0,0,0,0.12)');
    g.fillStyle = ab;
    g.fillRect(0, A.h * 0.55, A.w, A.h * 0.45);
    // Glass frame.
    g.strokeStyle = hexA(theme.hud.cyan, 0.55);
    g.lineWidth = 3;
    roundRect(g, 2, 2, A.w - 4, A.h - 4, 18);
    g.stroke();
    g.strokeStyle = hexA(theme.hud.cyan, 0.18);
    g.lineWidth = 8;
    roundRect(g, 8, 8, A.w - 16, A.h - 16, 14);
    g.stroke();
    // Corner starburst flares.
    g.globalCompositeOperation = 'lighter';
    const corners = [[26, 26], [A.w - 26, 26], [26, A.h - 26], [A.w - 26, A.h - 26]];
    for (const [cx, cy] of corners) {
      g.strokeStyle = hexA('#ffffff', 0.85);
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(cx - 14, cy); g.lineTo(cx + 14, cy);
      g.moveTo(cx, cy - 14); g.lineTo(cx, cy + 14);
      g.stroke();
      g.fillStyle = hexA(theme.hud.cyan, 0.5);
      g.beginPath(); g.arc(cx, cy, 4, 0, 6.29); g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  function buildGradeCaches() {
    vigCache = makeCanvas(W, H);
    let g = vigCache.getContext('2d');
    let gr = g.createRadialGradient(960, 540, 560, 960, 540, 1120);
    gr.addColorStop(0, 'rgba(0,0,0,0)');
    gr.addColorStop(1, 'rgba(0,0,0,' + theme.grade.vignette + ')');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    // S-curve (soft-light): deepens shadows, protects mids — the
    // tonemap stand-in for the C1 grade pass.
    curveCache = makeCanvas(W, H);
    g = curveCache.getContext('2d');
    const cv = g.createLinearGradient(0, 0, 0, H);
    cv.addColorStop(0, 'rgba(0,0,0,0.16)');
    cv.addColorStop(0.38, 'rgba(0,0,0,0)');
    cv.addColorStop(0.62, 'rgba(255,255,255,0.05)');
    cv.addColorStop(1, 'rgba(0,0,0,0.18)');
    g.fillStyle = cv;
    g.fillRect(0, 0, W, H);
    redVigCache = makeCanvas(W, H);
    g = redVigCache.getContext('2d');
    gr = g.createRadialGradient(960, 540, 520, 960, 540, 1100);
    gr.addColorStop(0, 'rgba(255,40,60,0)');
    gr.addColorStop(1, 'rgba(255,40,60,0.6)');
    g.fillStyle = gr;
    g.fillRect(0, 0, W, H);
    // Film grain tile.
    const tile = makeCanvas(128, 128);
    g = tile.getContext('2d');
    const img = g.createImageData(128, 128);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 22;
    }
    g.putImageData(img, 0, 0);
    grainPat = ctx.createPattern(tile, 'repeat');
  }

  /* ---------------- the 14 layers ---------------- */

  function render(view, vd, realDt) {
    const t = vd.time;
    const shx = vd.shake > 0 ? (Math.random() - 0.5) * 2 * vd.shake : 0;
    const shy = vd.shake > 0 ? (Math.random() - 0.5) * 2 * vd.shake : 0;

    ctx.save();
    ctx.translate(shx, shy);

    layerBackground(view, t);          // 1
    layerArena(view, t);               // 2
    if (view.phase === 'warp') layerWarpStreaks(t); // transition field
    layerBricks(view, t);              // 3
    layerCores(view, t);               // 4
    layerShots(view);                  // 5
    layerPaddle(view, vd, t);          // 6
    layerBalls(view);                  // 7
    layerTrails(view, vd);             // 8
    layerParticles(vd);                // 9
    layerShockwaves(vd);               // 10
    layerRays(vd);                     // 10b — combo/burst rays
    layerFlashes(vd);                  // 10c — impact flash pops (C5)
    layerFloaters(vd);                 // 11
    layerBloom(view, vd);              // 12
    layerGrade(vd, t);                 // 13

    ctx.restore();
    layerHUD(view, vd, t);             // 14 — crisp, never shaken/bloomed
    if (view.debug) layerDebug(view, vd);
  }

  function layerBackground(view, t) {
    const parX = (view.paddle.x - 960) * 0.012 + Math.sin(t * 0.05) * 6;
    const parY = Math.cos(t * 0.04) * 4;
    ctx.drawImage(bgCache, -20 + parX, -20 + parY);
    // Near stars twinkle (2-frame alpha swap feel via sine).
    ctx.fillStyle = theme.bg.starTint;
    for (const s of bgNearStars) {
      ctx.globalAlpha = 0.55 + 0.45 * Math.sin(t * 2.2 + s.ph);
      ctx.fillRect(-20 + parX * 1.6 + s.x, -20 + parY * 1.6 + s.y, s.r, s.r);
    }
    ctx.globalAlpha = 1;
  }

  function layerArena(view, t) {
    ctx.drawImage(arenaCache, 360, 140);
    // Subtle frame pulse (alpha only, no re-render).
    ctx.globalAlpha = 0.10 + 0.06 * Math.sin(t * 1.7);
    ctx.strokeStyle = theme.hud.cyan;
    ctx.lineWidth = 2;
    roundRect(ctx, 360, 140, 1200, 740, 18);
    ctx.stroke();
    ctx.globalAlpha = 1;
    // C5: corner starburst flare pulse (alpha only) over the baked
    // flares — the frame breathes without any re-render.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.28 + 0.22 * Math.sin(t * 2.4);
    const corners = [[386, 166], [1534, 166], [386, 854], [1534, 854]];
    for (const [cx, cy] of corners) {
      ctx.drawImage(glowSprite(theme.hud.cyan), cx - 30, cy - 30, 60, 60);
    }
    ctx.restore();
  }

  /* C5: sector warp transition — radial zoom streaks bursting from the
     arena center plus a slow swirl, accelerating with transition time.
     Pure render-side; the sim owns the phase timing. */
  function layerWarpStreaks(t) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const cx = 960, cy = 510;
    const spin = t * 1.9;
    for (let i = 0; i < 90; i++) {
      const ang = spin * 0.4 + (i / 90) * Math.PI * 2;
      const seed = ((i * 137.5) % 10) / 10;
      const rr0 = 110 + ((t * 640 + i * 173) % 920);
      const len = 60 + seed * 170;
      const ex = 0.62; // elliptical squash matches the arena aspect
      const x0 = cx + Math.cos(ang) * rr0, y0 = cy + Math.sin(ang) * rr0 * ex;
      const x1 = cx + Math.cos(ang) * (rr0 + len), y1 = cy + Math.sin(ang) * (rr0 + len) * ex;
      ctx.strokeStyle = i % 4 ? hexA(theme.hud.cyan, 0.38) : hexA('#ffffff', 0.55);
      ctx.lineWidth = i % 4 ? 2.5 : 4;
      ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    // Central swirl glow.
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glowSprite('#ffffff'), cx - 230, cy - 230, 460, 460);
    ctx.restore();
  }

  function layerBricks(view, t) {
    for (const b of view.bricks) {
      if (!b.alive) continue;
      const s = NB.Materials.brick(theme, b.kind, b.hp, b.palette);
      // Per-brick bloom halo + contact shadow, blit-only.
      if (s.glow) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.40;
        ctx.drawImage(glowSprite(s.glow), b.x - 16, b.y - 16, b.w + 32, b.h + 32);
        ctx.restore();
      }
      ctx.globalAlpha = 0.38;
      ctx.drawImage(aoCache, b.x - 5, b.y + b.h - 3, b.w + 10, 9);
      ctx.globalAlpha = 1;
      // Authored glass sprite (baked gradients, specular, glyph, rim, AO).
      ctx.drawImage(s.sprite, b.x - 14, b.y - 14);
      // Power-core carrier sigil: visual rarity marker on ~12% of glass
      // bricks (the drop itself stays sim-random; renderer-only, no sim read).
      if (b.kind === 'glass' && NB.Materials.isCarrier(b.x, b.y)) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55 + 0.35 * Math.sin(t * 5 + b.x * 0.7);
        ctx.drawImage(NB.Materials.sigil(), b.x + b.w / 2 - 15, b.y + b.h / 2 - 15);
        ctx.restore();
      }
      // Damage cracks once hp drops below max.
      if ((b.kind === 'glass' || b.kind === 'hazard') && b.hp < b.maxHp) {
        ctx.globalAlpha = 0.85;
        ctx.drawImage(NB.Materials.cracks(), b.x, b.y);
        ctx.globalAlpha = 1;
      }
      // Hit-flash: additive white, alpha only (sprite carries the detail).
      if (b.hitFlash > 0) {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = Math.min(1, b.hitFlash) * 0.6;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(b.x, b.y, b.w, b.h);
        ctx.restore();
      }
      // C5: hazard pulse overlay — a slow breathing orange rim on every
      // hazard brick (alpha animation, no sprite re-render).
      if (b.kind === 'hazard') {
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.20 + 0.20 * Math.sin(t * 4.2 + b.x * 0.05 + b.y * 0.03);
        ctx.strokeStyle = '#ff7a3d';
        ctx.lineWidth = 3;
        roundRect(ctx, b.x + 1.5, b.y + 1.5, b.w - 3, b.h - 3, 6);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  function layerCores(view, t) {
    for (const c of view.cores) {
      const spec = NB.Materials.core(theme, c.kind);
      const y = c.y + Math.sin(c.t) * 6;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.8;
      ctx.drawImage(glowSprite(spec.color), c.x - 30, y - 30, 60, 60);
      ctx.restore();
      // Faceted gem: 3-tone diamond + glint.
      ctx.fillStyle = spec.color;
      ctx.beginPath();
      ctx.moveTo(c.x, y - 17); ctx.lineTo(c.x + 13, y);
      ctx.lineTo(c.x, y + 17); ctx.lineTo(c.x - 13, y);
      ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.beginPath();
      ctx.moveTo(c.x, y - 17); ctx.lineTo(c.x + 13, y); ctx.lineTo(c.x, y);
      ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath(); ctx.arc(c.x - 4, y - 7, 2.4, 0, 6.29); ctx.fill();
      // C5: twinkle glint — a breathing 4-point sparkle marks the gem as
      // a live power core (cheap authored cross, additive).
      const tw = 0.5 + 0.5 * Math.sin(c.t * 3 + c.x * 0.11);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.30 + 0.45 * tw;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6;
      ctx.lineCap = 'round';
      const gl = 8 + 6 * tw;
      ctx.beginPath();
      ctx.moveTo(c.x - gl, y); ctx.lineTo(c.x + gl, y);
      ctx.moveTo(c.x, y - gl); ctx.lineTo(c.x, y + gl);
      ctx.stroke();
      ctx.restore();
    }
  }

  /* C5: laser bolts — triple-draw beam (orange halo, hot mid, white
     core) with a glowing head; reads as a plasma lance, not a line. */
  function layerShots(view) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const s of view.shots) {
      ctx.strokeStyle = 'rgba(255,154,61,0.45)';
      ctx.lineWidth = 11;
      ctx.beginPath(); ctx.moveTo(s.x, s.y + 36); ctx.lineTo(s.x, s.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(255,196,110,0.85)';
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(s.x, s.y + 34); ctx.lineTo(s.x, s.y); ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(s.x, s.y + 30); ctx.lineTo(s.x, s.y); ctx.stroke();
      // head glow
      ctx.globalAlpha = 0.8;
      ctx.drawImage(glowSprite('#ffb03a'), s.x - 16, s.y - 16, 32, 32);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  function layerPaddle(view, vd, t) {
    const p = view.paddle;
    const spec = NB.Materials.paddle(theme, p.state);
    const spr = NB.Materials.paddleSprite(p.width, p.state);
    const x = p.x - p.width / 2, y = 812 - 11, w = p.width, h = 22;
    const sx = x - 18, sy = y - 24; // sprite pad offset
    // Contact AO grounding the bar.
    ctx.globalAlpha = 0.55;
    ctx.drawImage(aoCache, x - w * 0.08, y + h - 4, w * 1.16, 30);
    ctx.globalAlpha = 1;
    // Under-glow ellipse.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.55;
    ctx.drawImage(glowSprite(spec.glow), x - 20, y - 8, w + 40, h + 48);
    ctx.restore();
    // Motion smear (C3): ghost blits at recent positions, alpha only.
    const hist = vd.paddleHist;
    if (hist.length > 3) {
      ctx.save();
      for (let k = 1; k <= 3; k++) {
        const gh = hist[hist.length - 1 - k * 2];
        if (!gh) break;
        if (Math.abs(gh.x - p.x) < 6) continue;
        ctx.globalAlpha = 0.16 / k;
        ctx.drawImage(spr, gh.x - w / 2 - 18, sy);
      }
      ctx.restore();
    }
    // Baked light-bar sprite: metallic base, key-lit top, end caps, cannons.
    ctx.drawImage(spr, sx, sy);
    // Neon core strip: animated flow inside the baked housing.
    const hx = x + 10, hw = w - 20, hy = y + 6, hh = h - 12;
    const segs = 9;
    ctx.save();
    ctx.beginPath(); ctx.rect(hx, hy, hw, hh); ctx.clip();
    for (let i = 0; i < segs; i++) {
      const ph = 0.5 + 0.5 * Math.sin(t * 7 + i * 0.85);
      ctx.fillStyle = ph > 0.62 ? '#ffffff' : spec.strip;
      ctx.globalAlpha = 0.5 + 0.5 * ph;
      const sx2 = hx + (i * hw) / segs;
      ctx.fillRect(sx2, hy + 1, hw / segs - 2, hh - 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
    // Laser heat tips above the cannons (additive).
    if (p.state === 'laser') {
      const off = w / 2 - 16;
      const heat = 0.5 + 0.5 * Math.sin(t * 10);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.45 + 0.45 * heat;
      ctx.fillStyle = '#ff9a3d';
      ctx.fillRect(p.x - off - 6, y - 22, 12, 7);
      ctx.fillRect(p.x + off - 6, y - 22, 12, 7);
      ctx.restore();
    }
    // C5: bounce impact flash — an additive glow + expanding ring at the
    // contact point when the ball strikes the light-bar.
    if (vd.paddleFlash > 0.01) {
      const pf = vd.paddleFlash, fx = vd.paddleFlashX;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = pf * 0.75;
      ctx.drawImage(glowSprite(spec.glow), fx - 75, y - 46, 150, 70);
      ctx.globalAlpha = pf * 0.85;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.ellipse(fx, y + 4, 18 + (1 - pf) * 52, 7 + (1 - pf) * 22, 0, 0, 6.29);
      ctx.stroke();
      ctx.restore();
    }
  }

  function layerBalls(view) {
    for (const b of view.balls) {
      const hs = NB.Materials.ballHeat(theme, b.heat);
      const spr = NB.Materials.ballSprite(hs.step);
      // Layered halo: wide faint + tight bright, additive.
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = 0.32;
      ctx.drawImage(glowSprite(hs.corona), b.x - b.r * 4.6, b.y - b.r * 4.6, b.r * 9.2, b.r * 9.2);
      ctx.globalAlpha = 0.85;
      ctx.drawImage(glowSprite(hs.corona), b.x - b.r * 2.6, b.y - b.r * 2.6, b.r * 5.2, b.r * 5.2);
      ctx.restore();
      // Pre-rendered plasma body: white-hot core -> colored corona.
      ctx.drawImage(spr, b.x - 36, b.y - 36);
    }
  }

  /* C5: the ribbon is speed-reactive in both directions — segment
     width and opacity scale with the point's recorded speed, so fast
     balls draw long bright ribbons and slow balls short faint ones. */
  function layerTrails(view, vd) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const b of view.balls) {
      const tr = vd.trails.get(b.id);
      if (!tr || tr.length < 2) continue;
      const hs = NB.Materials.ballHeat(theme, b.heat);
      for (let i = 1; i < tr.length; i++) {
        const f = i / tr.length;
        const vs = Math.min(1, (tr[i].v || 0) / 900); // 0..1 speed factor
        ctx.strokeStyle = f < 0.5 ? hs.trail : theme.ball.trailB;
        ctx.globalAlpha = f * (0.18 + 0.42 * vs);
        ctx.lineWidth = (2 + f * 7 * b.heat) * (0.65 + 0.55 * vs);
        ctx.beginPath();
        ctx.moveTo(tr[i - 1].x, tr[i - 1].y);
        ctx.lineTo(tr[i].x, tr[i].y);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* C5: particles render by shape — 'shard' as a rotating faceted
     diamond, 'streak' as a velocity-aligned plasma line, 'dot' as a
     soft square. All additive; alpha fades over life. */
  function layerParticles(vd) {
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const p of vd.particles) {
      const f = 1 - p.t / p.life;
      ctx.globalAlpha = f * 0.9;
      if (p.shape === 'shard') {
        ctx.fillStyle = p.color;
        const s = p.size * (0.45 + 0.55 * f);
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot + p.t * p.vr);
        ctx.beginPath();
        ctx.moveTo(0, -s); ctx.lineTo(s * 0.68, 0);
        ctx.lineTo(0, s); ctx.lineTo(-s * 0.68, 0);
        ctx.closePath(); ctx.fill();
        // additive edge glint
        ctx.globalAlpha = f * 0.7;
        ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1;
        ctx.stroke();
        ctx.restore();
      } else if (p.shape === 'streak') {
        ctx.strokeStyle = p.color;
        ctx.lineWidth = Math.max(1.5, p.size * 0.75 * f);
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.055, p.y - p.vy * 0.055);
        ctx.stroke();
      } else {
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
      }
    }
    // Ambient motes.
    ctx.fillStyle = theme.bg.motes;
    for (const m of vd.motes) {
      ctx.globalAlpha = 0.5 * (1 - m.t / m.life);
      ctx.beginPath(); ctx.arc(m.x, m.y, m.r, 0, 6.29); ctx.fill();
    }
    // Ember drift (C3): rising ambient particles, Ember Drift + Abyssal Teal.
    for (const e of vd.embers) {
      ctx.globalAlpha = 0.75 * (1 - e.t / e.life);
      ctx.fillStyle = e.color;
      ctx.beginPath(); ctx.arc(e.x, e.y, e.size, 0, 6.29); ctx.fill();
    }
    ctx.restore();
  }

  /* C5: impact flash pops — short white-hot radial discs spawned on
     every shatter, expanding and dying in ~0.28 s. */
  function layerFlashes(vd) {
    if (!vd.flashes.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const f of vd.flashes) {
      const k = 1 - f.t / f.life;
      const r = f.r * (0.35 + 0.95 * (1 - k));
      const g = ctx.createRadialGradient(f.x, f.y, 1, f.x, f.y, r);
      g.addColorStop(0, 'rgba(255,255,255,' + (0.92 * k).toFixed(3) + ')');
      g.addColorStop(0.45, hexA2(f.color, 0.55 * k));
      g.addColorStop(1, hexA2(f.color, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 6.29); ctx.fill();
    }
    ctx.restore();
  }

  function layerShockwaves(vd) {
    // C2-fix: white-hot center disc on young waves so combo/action frames
    // carry central luminance in the blur value structure.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const w of vd.waves) {
      const f = 1 - w.t / w.life;
      if (f > 0.25) { // white-hot core, strongest at birth
        const cr = Math.max(1, w.r * 0.55);
        const cg = ctx.createRadialGradient(w.x, w.y, 1, w.x, w.y, cr);
        cg.addColorStop(0, 'rgba(255,255,255,' + (0.95 * f).toFixed(3) + ')');
        cg.addColorStop(0.55, hexA2(w.color, 0.55 * f));
        cg.addColorStop(1, hexA2(w.color, 0));
        ctx.globalAlpha = 1;
        ctx.fillStyle = cg;
        ctx.beginPath(); ctx.arc(w.x, w.y, cr, 0, 6.29); ctx.fill();
      }
      ctx.globalAlpha = f * 0.95;
      ctx.strokeStyle = w.color;
      ctx.lineWidth = 3 + 5 * f;
      ctx.beginPath(); ctx.arc(w.x, w.y, w.r, 0, 6.29); ctx.stroke();
      ctx.globalAlpha = f * 0.5;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(w.x, w.y, w.r * 0.7, 0, 6.29); ctx.stroke();
    }
    ctx.restore();
  }

  function hexA2(hex, a) { // hexA for wave colors that may already be rgba
    if (hex[0] !== '#') return hex;
    const n = parseInt(hex.slice(1), 16);
    return 'rgba(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a.toFixed(3) + ')';
  }

  /* Combo-burst rays (C3): long rotating explosion rays spawned on
     multiplierUp, big-break (3+ shatters) and sectorCleared. */
  function layerRays(vd) {
    // C2-fix: brighter rays + white-hot core disc at the origin so
    // action frames read with a luminous burst center in the blur.
    if (!vd.rays.length) return;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineCap = 'round';
    for (const r of vd.rays) {
      const f = r.t / r.life;
      const a0 = vd.time * 0.9;
      const coreR = 180 * (1 - f) + 24;
      const cg = ctx.createRadialGradient(r.x, r.y, 1, r.x, r.y, coreR);
      cg.addColorStop(0, 'rgba(255,255,255,' + (0.95 * (1 - f)).toFixed(3) + ')');
      cg.addColorStop(0.5, hexA2(r.color, 0.5 * (1 - f)));
      cg.addColorStop(1, hexA2(r.color, 0));
      ctx.globalAlpha = 1;
      ctx.fillStyle = cg;
      ctx.beginPath(); ctx.arc(r.x, r.y, coreR, 0, 6.29); ctx.fill();
      for (let i = 0; i < r.n; i++) {
        const ang = a0 + (i / r.n) * Math.PI * 2;
        const r0 = 24 + f * 260;
        const r1 = r0 + 90 * (1 - f) + 26;
        ctx.globalAlpha = (1 - f) * 0.9;
        ctx.strokeStyle = r.color;
        ctx.lineWidth = 2 + 8 * (1 - f);
        ctx.beginPath();
        ctx.moveTo(r.x + Math.cos(ang) * r0, r.y + Math.sin(ang) * r0);
        ctx.lineTo(r.x + Math.cos(ang) * r1, r.y + Math.sin(ang) * r1);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /* C5: floating score text with a scale pop on birth (eases out),
     then rise + fade. Luminous double-draw, cheap for ~24 floaters. */
  function layerFloaters(vd) {
    for (const f of vd.floaters) {
      const a = 1 - f.t / f.life;
      const pop = 1 + 0.45 * Math.exp(-f.t * 9); // birth pop, eases out
      ctx.save();
      ctx.translate(f.x, f.y);
      ctx.scale(pop, pop);
      ctx.font = FONT(f.size);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = a * 0.5;
      ctx.fillStyle = f.color;
      const offs = [[2, 0], [-2, 0], [0, 2], [0, -2]];
      for (const [ox, oy] of offs) ctx.fillText(f.text, ox, oy);
      ctx.globalAlpha = a;
      ctx.fillStyle = '#ffffff';
      ctx.fillText(f.text, 0, 0);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function layerBloom(view, vd) {
    if (quality === 'off') return;
    const s = bloomScale;
    bctx.clearRect(0, 0, bloomC.width, bloomC.height);
    bctx.save();
    bctx.scale(s, s);
    bctx.globalCompositeOperation = 'lighter';
    const put = (x, y, r, color) => {
      bctx.globalAlpha = 0.9;
      bctx.drawImage(glowSprite(color), x - r, y - r, r * 2, r * 2);
    };
    for (const b of view.balls) {
      const hs = NB.Materials.ballHeat(theme, b.heat);
      put(b.x, b.y, b.r * 3, hs.corona);
    }
    // Selective bloom: bright elements only — balls, cores, shockwave
    // flashes, event flash. Paddle contribution kept small so the pass
    // stays a bright-pass, not a full-scene glow (LOOK.md C1).
    for (const c of view.cores) put(c.x, c.y, 26, theme.cores[c.kind] || '#fff');
    put(view.paddle.x, 812, view.paddle.width * 0.30, theme.paddle.glow);
    // C2-fix: waves/rays drive the value structure in action frames —
    // larger bloom radii so their white-hot cores survive the grade.
    for (const w of vd.waves) put(w.x, w.y, w.r * 1.1, w.color);
    for (const r of vd.rays) put(r.x, r.y, 60 + (r.t / r.life) * 260, r.color);
    if (vd.flash > 0) { bctx.globalAlpha = vd.flash; bctx.fillStyle = '#fff2d0'; bctx.fillRect(0, 0, W, H); }
    bctx.restore();
    // Blur the small canvas, then screen it back.
    bctx.save();
    bctx.filter = 'blur(8px)';
    bctx.drawImage(bloomC, 0, 0);
    bctx.restore();
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = quality === 'full' ? 0.6 : 0.45;
    ctx.drawImage(bloomC, 0, 0, W, H);
    ctx.restore();
  }

  function layerGrade(vd, t) {
    // Grade pass order: vignette -> S-curve -> lift wash -> grain ->
    // event overlays (red pulse, flash). HUD is drawn after, never graded.
    ctx.drawImage(vigCache, 0, 0);
    ctx.save();
    ctx.globalCompositeOperation = 'soft-light';
    ctx.drawImage(curveCache, 0, 0);
    ctx.restore();
    ctx.fillStyle = theme.grade.lift;
    ctx.fillRect(0, 0, W, H);
    if (grainPat) {
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.translate(-((t * 13) % 128), -((t * 7) % 128));
      ctx.fillStyle = grainPat;
      ctx.fillRect(0, 0, W + 128, H + 128);
      ctx.restore();
    }
    if (vd.redPulse > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(1, vd.redPulse);
      ctx.drawImage(redVigCache, 0, 0);
      ctx.restore();
    }
    if (vd.flash > 0) {
      ctx.save();
      ctx.globalAlpha = Math.min(0.5, vd.flash);
      ctx.fillStyle = '#fff2d0';
      ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }
  }

  /* ---------------- HUD (layer 14) — C4 craft ----------------
     Type system: heavy italic display type (system stack, styled —
     never a default unstyled sans): italic 900 display numerals with
     tight tracking and a luminous halo, 700 wide-tracked labels for
     hierarchy. Framed glass panels with gold corner ticks. Drawn after
     post, never shaken, never bloomed — always crisp. */

  // hudText: luminous display text. Halo = offset underdraws in the
  // text color, core = near-white; labels use glow:false for crispness.
  function hudText(text, x, y, size, color, o) {
    o = o || {};
    ctx.save();
    ctx.font = (o.italic === false ? '' : 'italic ') + (o.weight || 900) +
      ' ' + size + 'px "Arial Black","Helvetica Neue",Arial,sans-serif';
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'alphabetic';
    if (o.spacing) { try { ctx.letterSpacing = o.spacing + 'px'; } catch (e) {} }
    if (o.glow !== false) {
      ctx.globalAlpha = o.haloAlpha == null ? 0.62 : o.haloAlpha;
      ctx.fillStyle = color;
      const r = o.haloR || 2;
      const offs = [[r, 0], [-r, 0], [0, r], [0, -r],
                    [r, r], [-r, -r], [r, -r], [-r, r]];
      for (let i = 0; i < offs.length; i++) ctx.fillText(text, x + offs[i][0], y + offs[i][1]);
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = o.core || '#ffffff';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // framePanel: dark glass body, top hairline light, cyan hairline
  // border, gold corner ticks. The framed-panel grammar of the refs.
  function framePanel(x, y, w, h, accent) {
    accent = accent || theme.hud.gold;
    ctx.save();
    ctx.fillStyle = 'rgba(5,8,20,0.74)';
    roundRect(ctx, x, y, w, h, 10);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.14)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x + 14, y + 1.5); ctx.lineTo(x + w - 14, y + 1.5);
    ctx.stroke();
    ctx.strokeStyle = hexA(theme.hud.cyan, 0.34);
    ctx.lineWidth = 1.5;
    roundRect(ctx, x, y, w, h, 10);
    ctx.stroke();
    ctx.strokeStyle = accent;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    const c = 11;
    const corners = [[x, y, 1, 1], [x + w, y, -1, 1],
                     [x, y + h, 1, -1], [x + w, y + h, -1, -1]];
    for (const [cx, cy, sx, sy] of corners) {
      ctx.beginPath();
      ctx.moveTo(cx + sx * c, cy); ctx.lineTo(cx, cy); ctx.lineTo(cx, cy + sy * c);
      ctx.stroke();
    }
    ctx.restore();
  }

  function fmt(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  function fmtTime(s) {
    const mm = String(Math.floor(s / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return mm + ':' + ss;
  }

  function layerHUD(view, vd, t) {
    const h = view.hud;

    // Top-left: SCORE panel — cyan score, gold best beneath.
    framePanel(24, 16, 356, 106, theme.hud.cyan);
    hudText('SCORE', 48, 46, 15, theme.hud.cyan,
      { weight: 700, spacing: 7, glow: false, core: hexA(theme.hud.cyan, 0.95) });
    hudText(fmt(h.score), 46, 92, 54, theme.hud.cyan, { spacing: 1 });
    hudText('BEST ' + fmt(Math.max(h.best, h.score)), 48, 113, 17, theme.hud.gold,
      { weight: 700, spacing: 4, glow: false, core: hexA(theme.hud.gold, 0.95) });

    // Top-center: the big combo multiplier (floating, gold), sector
    // readout with invented sector name, and the sector timer beneath.
    const pulse = 1 + 0.045 * Math.sin(t * 6) * Math.min(1, h.comboFrac * 2);
    ctx.save();
    ctx.translate(960, 66); ctx.scale(pulse, pulse);
    hudText(h.multiplier + 'x', 0, 0, 68, theme.hud.gold, { align: 'center', spacing: 2 });
    ctx.restore();
    hudText('SECTOR ' + h.sector + ' · ' + theme.name.toUpperCase(), 960, 98, 20, '#ffffff',
      { align: 'center', weight: 700, spacing: 5, glow: false, core: 'rgba(255,255,255,0.92)' });
    hudText(fmtTime(h.timer), 960, 124, 18, theme.hud.cyan,
      { align: 'center', weight: 700, spacing: 4, glow: false, core: hexA(theme.hud.cyan, 0.9) });

    // Top-right: COURT pot panel — label, cyan pot, drain bar.
    framePanel(1540, 16, 356, 106, theme.hud.cyan);
    hudText('COURT', 1872, 46, 15, theme.hud.cyan,
      { align: 'right', weight: 700, spacing: 7, glow: false, core: hexA(theme.hud.cyan, 0.95) });
    hudText(fmt(h.court), 1874, 92, 44, theme.hud.cyan, { align: 'right', spacing: 1 });
    const cw = 308, cx0 = 1874 - cw;
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(cx0, 98, cw, 5);
    ctx.fillStyle = theme.hud.cyan;
    ctx.fillRect(cx0, 98, cw * (h.courtMax ? h.court / h.courtMax : 0), 5);

    // Bottom-left: HULL — framed hex-cell cluster.
    framePanel(24, 972, 60 + h.hullMax * 46, 90, theme.hud.red);
    hudText('HULL', 48, 1000, 15, theme.hud.red,
      { weight: 700, spacing: 7, glow: false, core: hexA(theme.hud.red, 0.95) });
    for (let i = 0; i < h.hullMax; i++) {
      const cx = 66 + i * 46, cy = 1032;
      hexPath(cx, cy, 16);
      if (i < h.hull) {
        ctx.fillStyle = theme.hud.red;
        ctx.fill();
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.55;
        ctx.drawImage(glowSprite(theme.hud.red), cx - 23, cy - 23, 46, 46);
        ctx.restore();
        // inner bright core on live cells
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath(); ctx.arc(cx - 3, cy - 3, 3, 0, 6.29); ctx.fill();
      } else {
        ctx.strokeStyle = 'rgba(255,77,94,0.4)';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Bottom-center: energy bar — active power-core timers as segments.
    const segs = [];
    if (h.power.wide > 0) segs.push({ label: 'WIDE', t: h.power.wide, max: 20, color: '#4da3ff' });
    if (h.power.laser > 0) segs.push({ label: 'LASER', t: h.power.laser, max: 12, color: '#ff9a3d' });
    if (h.power.slow > 0) segs.push({ label: 'SLOW', t: h.power.slow, max: 8, color: '#b06bff' });
    if (segs.length) {
      const bw = 210, gap = 14;
      const total = segs.length * bw + (segs.length - 1) * gap;
      let bx = 960 - total / 2;
      hudText('ENERGY', 960, 990, 14, '#ffffff',
        { align: 'center', weight: 700, spacing: 6, glow: false, core: 'rgba(255,255,255,0.75)' });
      for (const s of segs) {
        framePanel(bx, 998, bw, 58, s.color);
        hudText(s.label + ' ' + s.t.toFixed(0) + 's', bx + bw / 2, 1022, 19, s.color,
          { align: 'center', weight: 700, spacing: 3, glow: false, core: s.color });
        ctx.fillStyle = 'rgba(255,255,255,0.14)';
        ctx.fillRect(bx + 14, 1034, bw - 28, 6);
        ctx.fillStyle = s.color;
        ctx.fillRect(bx + 14, 1034, (bw - 28) * Math.min(1, s.t / s.max), 6);
        bx += bw + gap;
      }
    }

    // Combo meter: a framed mini-bar under the arena, live while the
    // combo window burns down.
    if (h.comboFrac > 0 && h.multiplier > 1) {
      framePanel(740, 886, 440, 34, theme.hud.gold);
      hudText('COMBO', 758, 909, 14, theme.hud.gold,
        { weight: 700, spacing: 4, glow: false, core: hexA(theme.hud.gold, 0.9) });
      ctx.fillStyle = 'rgba(255,255,255,0.14)';
      ctx.fillRect(848, 899, 314, 6);
      ctx.fillStyle = theme.hud.gold;
      ctx.fillRect(848, 899, 314 * h.comboFrac, 6);
    }

    // Phase cards.
    if (view.phase === 'title') cardTitle(view, t);
    else if (view.phase === 'serve') cardServe(view, t);
    else if (view.phase === 'paused') cardPause();
    else if (view.phase === 'warp') cardWarp(view);
    else if (view.phase === 'gameover') cardGameOver(view, t);
    else if (view.phase === 'clear') {
      hudText('SECTOR CLEAR', 960, 700, 54, theme.hud.gold, { align: 'center', spacing: 6 });
    }
  }

  function hexPath(cx, cy, r) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 6 + i * Math.PI / 3;
      const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function dimScreen(a) {
    ctx.fillStyle = 'rgba(3,4,12,' + a + ')';
    ctx.fillRect(0, 0, W, H);
  }

  function cardTitle(view, t) {
    dimScreen(0.5);
    framePanel(560, 300, 800, 420, theme.hud.cyan);
    const glowPulse = 0.30 + 0.18 * Math.sin(t * 2);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = glowPulse;
    ctx.font = 'italic 900 118px "Arial Black","Helvetica Neue",Arial,sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = theme.hud.cyan;
    ctx.fillText('NEON BREAKER', 960, 452);
    ctx.restore();
    hudText('NEON BREAKER', 960, 452, 118, theme.hud.cyan, { align: 'center', spacing: 4 });
    // gold divider
    ctx.fillStyle = theme.hud.gold;
    ctx.fillRect(860, 490, 200, 3);
    hudText('A NEON BRICK-BREAKER HOMAGE', 960, 545, 26, theme.hud.gold,
      { align: 'center', weight: 700, spacing: 6, glow: false, core: hexA(theme.hud.gold, 0.95) });
    hudText('MOUSE OR ARROW KEYS TO MOVE  ·  CLICK / SPACE TO LAUNCH  ·  P PAUSE', 960, 600, 21, '#aab4d4',
      { align: 'center', weight: 700, spacing: 3, glow: false, core: 'rgba(170,180,212,0.95)' });
    if (Math.sin(t * 4) > 0) {
      hudText('— CLICK OR PRESS SPACE TO START —', 960, 668, 30, theme.hud.cyan,
        { align: 'center', spacing: 3 });
    }
    if (view.hud.best > 0) {
      hudText('BEST ' + fmt(view.hud.best), 960, 706, 24, theme.hud.gold,
        { align: 'center', weight: 700, spacing: 4, glow: false, core: hexA(theme.hud.gold, 0.9) });
    }
  }

  function cardServe(view, t) {
    if (Math.sin(t * 4) > -0.3) {
      framePanel(760, 918, 400, 56, theme.hud.cyan);
      hudText('CLICK / SPACE TO LAUNCH', 960, 954, 24, '#ffffff',
        { align: 'center', weight: 700, spacing: 4, glow: false, core: 'rgba(255,255,255,0.95)' });
    }
  }

  function cardPause() {
    dimScreen(0.62);
    framePanel(720, 400, 480, 260, theme.hud.gold);
    hudText('PAUSED', 960, 540, 72, '#ffffff', { align: 'center', spacing: 8 });
    hudText('PRESS P TO RESUME', 960, 600, 24, theme.hud.cyan,
      { align: 'center', weight: 700, spacing: 5, glow: false, core: hexA(theme.hud.cyan, 0.95) });
  }

  function cardWarp(view) {
    dimScreen(0.3);
    framePanel(660, 380, 600, 260, theme.hud.gold);
    hudText('SECTOR ' + view.hud.sector + ' CLEAR', 960, 478, 58, theme.hud.gold,
      { align: 'center', spacing: 3 });
    hudText('COURT BONUS +' + fmt(view.hud.banked), 960, 540, 32, theme.hud.cyan,
      { align: 'center', weight: 700, spacing: 4, glow: false, core: hexA(theme.hud.cyan, 0.95) });
    hudText('WARPING TO SECTOR ' + (view.hud.sector + 1), 960, 592, 24, '#ffffff',
      { align: 'center', weight: 700, spacing: 5, glow: false, core: 'rgba(255,255,255,0.92)' });
  }

  function cardGameOver(view, t) {
    dimScreen(0.62);
    framePanel(560, 300, 800, 420, theme.hud.red);
    hudText('RUN OVER', 960, 448, 96, theme.hud.red, { align: 'center', spacing: 6 });
    hudText('FINAL SCORE  ' + fmt(view.hud.score), 960, 520, 38, '#ffffff',
      { align: 'center', weight: 700, spacing: 4, glow: false, core: 'rgba(255,255,255,0.95)' });
    hudText((view.hud.newBest ? 'NEW BEST!  ' : 'BEST  ') + fmt(view.hud.best), 960, 576, 28, theme.hud.gold,
      { align: 'center', spacing: 3 });
    if (Math.sin(t * 4) > 0) {
      hudText('— CLICK / SPACE / R TO RETRY —', 960, 668, 28, theme.hud.cyan,
        { align: 'center', spacing: 3 });
    }
  }

  function layerDebug(view, vd) {
    ctx.textAlign = 'left';
    ctx.font = '700 20px monospace';
    ctx.fillStyle = '#7dff9a';
    const lines = [
      'fps ' + view.debug.fps.toFixed(0) + '  quality ' + quality,
      'balls ' + view.balls.length + '  bricks ' + view.bricks.filter(b => b.alive).length +
      '  particles ' + vd.particles.length,
      'phase ' + view.phase + '  sector ' + view.hud.sector + '  timescale ' + view.debug.timeScale.toFixed(2),
      'theme ' + themeKey,
    ];
    lines.forEach((l, i) => ctx.fillText(l, 24, 140 + i * 26));
  }

  return {
    init, setTheme, setQuality, render,
    getTheme: () => theme, getThemeKey: () => themeKey,
    hexA, FONT,
  };
})();
