'use strict';
/* NB.Input — hardware events -> normalized per-frame commands.
   The sim reads commands, never raw events (fixed-timestep determinism,
   headless-testable). Non-goals: no touch controls (brief). */
var NB = (window.NB = window.NB || {});

NB.Input = (() => {
  const held = { left: false, right: false };
  const state = {
    paddleTargetX: null, // absolute mouse target, canvas pixels
    paddleVelDir: 0,     // -1 | 0 | 1 from keys (velocity mode)
    launchQueued: false,
    fireQueued: false,
    pauseToggled: false,
    restartQueued: false,
  };

  function toCanvasX(clientX, canvas) {
    const r = canvas.getBoundingClientRect();
    return (clientX - r.left) * (1920 / r.width);
  }

  function attach(canvas) {
    window.addEventListener('pointermove', (e) => {
      state.paddleTargetX = toCanvasX(e.clientX, canvas);
    }, { passive: true });

    window.addEventListener('pointerdown', (e) => {
      state.paddleTargetX = toCanvasX(e.clientX, canvas);
      state.launchQueued = true;
      state.fireQueued = true;
    });

    window.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') { held.left = true; e.preventDefault(); }
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') { held.right = true; e.preventDefault(); }
      else if (k === ' ' || k === 'Enter') {
        state.launchQueued = true; state.fireQueued = true; e.preventDefault();
      }
      else if (k === 'p' || k === 'P' || k === 'Escape') { state.pauseToggled = true; }
      else if (k === 'r' || k === 'R') { state.restartQueued = true; }
      else if (k === 'm' || k === 'M') { if (NB.Audio) NB.Audio.toggleMute(); }
    });

    window.addEventListener('keyup', (e) => {
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'a' || k === 'A') held.left = false;
      else if (k === 'ArrowRight' || k === 'd' || k === 'D') held.right = false;
    });

    window.addEventListener('blur', () => { held.left = held.right = false; });
  }

  /* Snapshot the commands for this frame and clear one-shot queues. */
  function consume() {
    const cmd = {
      paddleTargetX: state.paddleTargetX,
      paddleVelDir: (held.right ? 1 : 0) - (held.left ? 1 : 0),
      launchQueued: state.launchQueued,
      fireQueued: state.fireQueued,
      pauseToggled: state.pauseToggled,
      restartQueued: state.restartQueued,
      _used: false,
    };
    state.launchQueued = false;
    state.fireQueued = false;
    state.pauseToggled = false;
    state.restartQueued = false;
    return cmd;
  }

  return { attach, consume };
})();
