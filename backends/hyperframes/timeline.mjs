/**
 * Deterministic timeline for the HyperFrames backend.
 *
 * HyperFrames seeks a paused GSAP timeline once per rendered frame, so motion has
 * to be a pure function of time — CSS animations run off the wall clock and would
 * not survive frame-by-frame capture. The backend also forbids loading GSAP from a
 * CDN, so this supplies the small GSAP-compatible surface the runtime touches.
 *
 * `buildTimelineProgram` produces plain data, and the browser runtime applies it.
 * Both sides share `sampleTween`, so what the tests assert is what renders.
 */

const ENTRANCE_SECONDS = 0.45;
const STEP_STAGGER_SECONDS = 0.55;
const STEP_LEAD_SECONDS = 0.3;
const CAST_LIFT_SECONDS = 0.35;

/** Ease-out cubic: quick to arrive, slow to settle. */
export function easeOutCubic(t) {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  return 1 - Math.pow(1 - clamped, 3);
}

export function sampleTween(tween, time) {
  const elapsed = time - tween.at;
  const duration = tween.duration > 0 ? tween.duration : 0.0001;
  const progress = easeOutCubic(elapsed / duration);
  const state = {};
  for (const key of Object.keys(tween.to)) {
    const from = tween.from[key] ?? 0;
    const to = tween.to[key];
    state[key] = round(from + (to - from) * progress);
  }
  return state;
}

function round(value) {
  return Math.round(value * 10000) / 10000;
}

export function buildTimelineProgram(manifest) {
  const program = [];
  const captions = manifest?.captions ?? [];
  const speakers = manifest?.speakers ?? [];

  for (const caption of captions) {
    const id = caption.id;
    if (!id) continue;
    const lineEnd = caption.end;

    if (caption.visual?.headline) {
      program.push({
        selector: `#${id}-visual`,
        at: caption.start,
        duration: ENTRANCE_SECONDS,
        from: { opacity: 0, y: 18, scale: 0.985 },
        to: { opacity: 1, y: 0, scale: 1 }
      });

      const steps = Array.isArray(caption.visual.steps) ? caption.visual.steps : [];
      steps.forEach((_step, index) => {
        const at = Math.min(
          caption.start + STEP_LEAD_SECONDS + index * STEP_STAGGER_SECONDS,
          Math.max(caption.start, lineEnd - ENTRANCE_SECONDS)
        );
        program.push({
          selector: `#${id}-visual [data-step-index="${index}"]`,
          at,
          duration: ENTRANCE_SECONDS,
          from: { opacity: 0, x: 16 },
          to: { opacity: 1, x: 0 }
        });
      });
    }

    if (speakers.length > 0 && caption.speaker) {
      program.push({
        selector: `#${id}-cast [data-speaker="${caption.speaker}"]`,
        at: caption.start,
        duration: CAST_LIFT_SECONDS,
        from: { y: 10 },
        to: { y: 0 }
      });
    }
  }

  return program;
}

/**
 * Browser-side runtime. Implements the slice of the GSAP timeline API the
 * HyperFrames runtime calls, and applies the program on every seek.
 */
export function renderTimelineRuntime(program) {
  return `(() => {
  const PROGRAM = ${JSON.stringify(program)};

  ${easeOutCubic.toString()}

  ${sampleTween.toString()}

  ${round.toString()}

  const targets = new Map();
  function resolve(selector) {
    if (!targets.has(selector)) {
      targets.set(selector, Array.from(document.querySelectorAll(selector)));
    }
    return targets.get(selector);
  }

  function applyAt(time) {
    for (const tween of PROGRAM) {
      const state = sampleTween(tween, time);
      for (const element of resolve(tween.selector)) {
        if (state.opacity !== undefined) element.style.opacity = String(state.opacity);
        const x = state.x ?? 0;
        const y = state.y ?? 0;
        const scale = state.scale ?? 1;
        if (state.x !== undefined || state.y !== undefined || state.scale !== undefined) {
          element.style.transform = "translate(" + x + "px," + y + "px) scale(" + scale + ")";
        }
      }
    }
  }

  class TsugiteTimeline {
    constructor() { this.currentTime = 0; this.currentScale = 1; this.apply(0); }
    apply(value) { this.currentTime = Number(value) || 0; applyAt(this.currentTime); return this; }
    pause() { return this; }
    play() { return this; }
    seek(value) { return this.apply(value); }
    totalTime(value) { if (value === undefined) return this.currentTime; return this.apply(value); }
    time(value) { if (value === undefined) return this.currentTime; return this.apply(value); }
    duration() { return this.totalDuration(); }
    totalDuration() { return PROGRAM.reduce((max, t) => Math.max(max, t.at + t.duration), 0); }
    timeScale(value) { if (value === undefined) return this.currentScale; this.currentScale = Number(value) || 1; return this; }
    progress(value) {
      const total = this.totalDuration();
      if (value === undefined) return total > 0 ? this.currentTime / total : 0;
      return this.apply((Number(value) || 0) * total);
    }
    getChildren() { return []; }
    getTweensOf() { return []; }
    eventCallback() { return this; }
    add() { return this; }
    set() { return this; }
    to() { return this; }
    from() { return this; }
    fromTo() { return this; }
    clear() { return this; }
    kill() { return this; }
  }

  window.gsap = { timeline: () => new TsugiteTimeline() };
})();
`;
}
