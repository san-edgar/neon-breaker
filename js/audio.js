'use strict';
/* NB.Audio — WebAudio-synthesized SFX, no assets. Initialized on first
   user gesture; headless captures run silent (never a failure). M mutes. */
var NB = (window.NB = window.NB || {});

NB.Audio = (() => {
  let actx = null, muted = false;

  function ensure() {
    if (actx) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      actx = new AC();
      return true;
    } catch (e) { return false; }
  }

  function blip(freq, dur, type, vol, slide) {
    if (muted || !ensure()) return;
    try {
      const t = actx.currentTime;
      const o = actx.createOscillator();
      const g = actx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t);
      if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(30, freq + slide), t + dur);
      g.gain.setValueAtTime(vol || 0.12, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g); g.connect(actx.destination);
      o.start(t); o.stop(t + dur + 0.02);
    } catch (e) { /* silent */ }
  }

  function noise(dur, vol) {
    if (muted || !ensure()) return;
    try {
      const t = actx.currentTime;
      const len = Math.floor(actx.sampleRate * dur);
      const buf = actx.createBuffer(1, len, actx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
      const src = actx.createBufferSource();
      src.buffer = buf;
      const g = actx.createGain();
      g.gain.setValueAtTime(vol || 0.15, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      src.connect(g); g.connect(actx.destination);
      src.start(t);
    } catch (e) { /* silent */ }
  }

  function unlock() { ensure(); }
  function toggleMute() { muted = !muted; }

  // Named SFX hooks called by main from sim events.
  return {
    unlock, toggleMute,
    brick: () => blip(660, 0.09, 'square', 0.10, 220),
    paddle: () => blip(330, 0.07, 'square', 0.08, 110),
    launch: () => blip(220, 0.16, 'sawtooth', 0.10, 440),
    core: () => { blip(880, 0.12, 'sine', 0.12, 440); blip(1320, 0.18, 'sine', 0.08, 0); },
    lose: () => blip(180, 0.4, 'sawtooth', 0.14, -120),
    clear: () => { blip(523, 0.15, 'sine', 0.12, 0); setTimeout(() => blip(784, 0.25, 'sine', 0.12, 0), 120); },
    laser: () => blip(1400, 0.08, 'sawtooth', 0.06, -600),
    shatter: () => noise(0.18, 0.12),
  };
})();
