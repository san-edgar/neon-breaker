'use strict';
/* NB.Themes — the swappable look layer. A Theme is a plain data object:
   background recipe, fake key light, brick/ball/paddle palettes, HUD
   colors, explosion colors, and the color grade. The sim never reads
   a Theme; only the renderer/materials do. Sector n uses theme
   (n-1) % 4. ?theme=<name> forces one theme (swap-test seam). */
var NB = (window.NB = window.NB || {});

NB.Themes = (() => {
  const T = {
    violet: {
      name: 'Violet Deep',
      bg: {
        // C2-fix: raised value level — bright luminous violet crystal field
        // that fills the frame (C3 blur structure).
        baseStops: ['#1c0f3d', '#301a70', '#4726a0', '#1c0f3d'],
        prop: 'facets', // C3: crystalline facet polygons (R1, R6)
        nebula: [
          { x: 0.25, y: 0.30, r: 420, color: '#5b2bd9', a: 0.55 },
          { x: 0.78, y: 0.62, r: 520, color: '#2b4bd9', a: 0.50 },
          { x: 0.55, y: 0.85, r: 380, color: '#8a2bd9', a: 0.42 },
        ],
        starTint: '#cfe0ff',
        motes: '#9a7bff',
      },
      keyLight: { x: 960, y: -160, r: 950, color: '#8a6bff', azimuth: 'top-left', a: 0.44 },
      ambient: { sky: '#7a5cff', skyA: 0.20, ground: '#120826', groundA: 0.10 },
      fog: { color: '#3a2278', a: 0.14 },
      // C2-fix: bright luminous border wash (refs read bright at the
      // frame edges, luminous field filling the frame).
      edgeGlow: { color: '#c98ff0', a: 0.55 },
      arenaField: ['#352065', '#4a2c82', '#352065'],
      palettes: {
        glass: ['#3ddc84', '#35c48f', '#2ba8c9'],
        hazard: '#ff453a',
        unbreakable: '#5a6274',
      },
      ball: { core: '#ffffff', corona: '#ffd34d', trailA: '#ffb03a', trailB: '#ff7a1a' },
      paddle: { base: '#1a2140', coreStrip: '#7df9ff', cap: '#ffd34d', glow: '#35c4ff' },
      cores: { multi: '#39e6c3', wide: '#4da3ff', laser: '#ff9a3d', slow: '#b06bff', hull: '#ffd34d' },
      hud: { cyan: '#35e0ff', gold: '#ffd34d', red: '#ff4d5e', panel: 'rgba(10,14,38,0.72)' },
      explosion: { core: '#fff6d8', ring: '#ffd34d', shards: ['#3ddc84', '#ffd34d', '#ffffff'] },
      grade: { vignette: 0.22, lift: 'rgba(70,40,160,0.16)' },
    },
    ember: {
      name: 'Ember Drift',
      bg: {
        // C2-fix: warm amber wash at higher value; white-hot action core
        // carried by rays/shockwaves (renderer).
        baseStops: ['#4a2a14', '#8a4a1e', '#b86a2e', '#4a2a14'],
        prop: 'smoke', // C3: dark silhouettes + haze plumes (R2)
        nebula: [
          { x: 0.70, y: 0.25, r: 480, color: '#d94f2b', a: 0.65 },
          { x: 0.20, y: 0.70, r: 420, color: '#8a2b1a', a: 0.60 },
          { x: 0.50, y: 0.55, r: 560, color: '#b0622b', a: 0.45 },
        ],
        starTint: '#ffe2c4',
        motes: '#ff9a5c',
      },
      keyLight: { x: 960, y: -160, r: 950, color: '#ff9a4d', azimuth: 'top-left', a: 0.45 },
      ambient: { sky: '#ff9a4d', skyA: 0.22, ground: '#200a04', groundA: 0.10 },
      fog: { color: '#8a3a16', a: 0.16 },
      // C2-fix: bright warm amber border wash (refs read bright at the
      // frame edges, warm value wash filling the frame).
      edgeGlow: { color: '#ffbe78', a: 0.58 },
      arenaField: ['#5e2812', '#7e3518', '#5e2812'],
      palettes: {
        glass: ['#ffd34d', '#ffb03a', '#ff8a3d'],
        hazard: '#ff2b1a',
        unbreakable: '#5a5348',
      },
      ball: { core: '#ffffff', corona: '#ffdf6b', trailA: '#ff9a3d', trailB: '#ff4d1a' },
      paddle: { base: '#33180f', coreStrip: '#ff7ad9', cap: '#ffd34d', glow: '#ff6b9a' },
      cores: { multi: '#39e6c3', wide: '#4da3ff', laser: '#ffb03d', slow: '#b06bff', hull: '#ffe27a' },
      hud: { cyan: '#7df9ff', gold: '#ffcf4d', red: '#ff4d5e', panel: 'rgba(40,14,8,0.72)' },
      explosion: { core: '#fff3d0', ring: '#ff8a3d', shards: ['#ff8a3d', '#ffd34d', '#ff4d4d'] },
      grade: { vignette: 0.22, lift: 'rgba(170,70,18,0.16)' },
    },
    glacier: {
      name: 'Glacier Vault',
      bg: {
        // C2-fix: brightly lit industrial interior at mid-gray value.
        baseStops: ['#17293f', '#2a4262', '#3d5982', '#17293f'],
        prop: 'streaks', // C3: industrial light streaks + machinery (R3, R4)
        nebula: [
          { x: 0.30, y: 0.25, r: 460, color: '#2b7bd9', a: 0.50 },
          { x: 0.75, y: 0.65, r: 500, color: '#1a4b8a', a: 0.48 },
          { x: 0.55, y: 0.90, r: 360, color: '#3d9bd9', a: 0.36 },
        ],
        starTint: '#d8f0ff',
        motes: '#7fc4ff',
      },
      keyLight: { x: 960, y: -160, r: 950, color: '#9ad9ff', azimuth: 'top-left', a: 0.34 },
      ambient: { sky: '#9ad9ff', skyA: 0.22, ground: '#081426', groundA: 0.10 },
      fog: { color: '#4c6c96', a: 0.16 },
      // C2-fix: bright border wash (brightly lit industrial interior).
      edgeGlow: { color: '#bfe0ff', a: 0.52 },
      arenaField: ['#2e4160', '#41587e', '#2e4160'],
      palettes: {
        glass: ['#59c2ff', '#3d8bff', '#7fe3ff'],
        hazard: '#ff3b30',
        unbreakable: '#4a5568',
      },
      ball: { core: '#ffffff', corona: '#cfeaff', trailA: '#7fc4ff', trailB: '#3d8bff' },
      paddle: { base: '#101c30', coreStrip: '#aef3ff', cap: '#ffd34d', glow: '#59c2ff' },
      cores: { multi: '#39e6c3', wide: '#4da3ff', laser: '#ff9a3d', slow: '#b06bff', hull: '#ffd34d' },
      hud: { cyan: '#59d8ff', gold: '#ffd34d', red: '#ff4d5e', panel: 'rgba(8,18,36,0.72)' },
      explosion: { core: '#ffffff', ring: '#7fc4ff', shards: ['#59c2ff', '#ffb03a', '#ffffff'] },
      grade: { vignette: 0.22, lift: 'rgba(60,110,180,0.16)' },
    },
    abyssal: {
      name: 'Abyssal Teal',
      bg: {
        // C2-fix: bright teal at higher value; explosion burst dominance via
        // rays/shockwave white-hot cores (renderer).
        baseStops: ['#08241d', '#104d3d', '#186452', '#08241d'],
        prop: 'ribbons', // C3: swooping light ribbons (R5)
        nebula: [
          { x: 0.25, y: 0.35, r: 460, color: '#1a8a6b', a: 0.55 },
          { x: 0.80, y: 0.55, r: 520, color: '#0f5a4a', a: 0.52 },
          { x: 0.55, y: 0.15, r: 380, color: '#2bd9a8', a: 0.36 },
        ],
        starTint: '#d0ffe8',
        motes: '#5ce6b0',
      },
      keyLight: { x: 960, y: -160, r: 950, color: '#5ce6b0', azimuth: 'top-left', a: 0.38 },
      ambient: { sky: '#5ce6b0', skyA: 0.20, ground: '#06231c', groundA: 0.10 },
      fog: { color: '#1f7c5e', a: 0.16 },
      // C2-fix: bright border wash (bright teal luminous field).
      edgeGlow: { color: '#9df0c8', a: 0.52 },
      arenaField: ['#0f4436', '#1a6650', '#0f4436'],
      palettes: {
        glass: ['#b06bff', '#8a4dff', '#6b3dd9'],
        hazard: '#ff453a',
        unbreakable: '#3a4a4a',
      },
      ball: { core: '#ffffff', corona: '#ffd7f2', trailA: '#ff9ad9', trailB: '#b06bff' },
      paddle: { base: '#0f2430', coreStrip: '#7df9ff', cap: '#ffd34d', glow: '#39e6c3' },
      cores: { multi: '#39e6c3', wide: '#4da3ff', laser: '#ff9a3d', slow: '#c9a3ff', hull: '#ffd34d' },
      hud: { cyan: '#39e6ff', gold: '#ffd34d', red: '#ff4d5e', panel: 'rgba(6,30,26,0.72)' },
      explosion: { core: '#fff0fa', ring: '#ff9ad9', shards: ['#b06bff', '#ffd34d', '#ffffff'] },
      grade: { vignette: 0.22, lift: 'rgba(30,140,105,0.16)' },
    },
  };

  const ORDER = ['violet', 'ember', 'glacier', 'abyssal'];

  function forSector(sector) {
    return T[ORDER[(sector - 1) % ORDER.length]];
  }

  return { all: T, order: ORDER, forSector };
})();
