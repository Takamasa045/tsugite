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
 *
 * Mouth frames are not tweens: they flip by discrete index via the shared
 * `mouthIndexAtSeconds` helper, matching the Remotion cycle.
 */

import { mouthIndexAtSeconds, DEFAULT_MOUTH_FPS } from "../mouth.mjs";

const ENTRANCE_SECONDS = 0.55;
const STEP_STAGGER_SECONDS = 0.42;
const STEP_LEAD_SECONDS = 0.22;
const CAST_LIFT_SECONDS = 0.42;

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
  const total = Number(manifest?.meta?.target_duration_seconds) || 0;

  // Top progress bar: scaleX from the left over the whole piece.
  if (total > 0) {
    program.push({
      selector: "#progress-fill",
      at: 0,
      duration: total,
      from: { scaleX: 0 },
      to: { scaleX: 1 }
    });
  }

  for (const caption of captions) {
    const id = caption.id;
    if (!id) continue;
    const lineEnd = caption.end;

    if (caption.visual?.headline) {
      program.push({
        selector: `#${id}-visual`,
        at: caption.start,
        duration: ENTRANCE_SECONDS,
        from: { opacity: 0, y: 36, scale: 0.9 },
        to: { opacity: 1, y: 0, scale: 1 }
      });
      // Stat punch: the giant number pops a beat after the card lands.
      program.push({
        selector: `#${id}-visual [data-role="stat"]`,
        at: caption.start + 0.08,
        duration: Math.min(0.4, ENTRANCE_SECONDS),
        from: { opacity: 0, scale: 0.82, y: 18 },
        to: { opacity: 1, scale: 1, y: 0 }
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
          from: { opacity: 0, x: 28, y: 10 },
          to: { opacity: 1, x: 0, y: 0 }
        });
      });
    }

    if (speakers.length > 0 && caption.speaker) {
      program.push({
        selector: `#${id}-cast [data-speaker="${caption.speaker}"]`,
        at: caption.start,
        duration: CAST_LIFT_SECONDS,
        from: { y: 22, scale: 0.94 },
        to: { y: 0, scale: 1 }
      });
      program.push({
        selector: `#${id}-cast .side-glow[data-active="true"]`,
        at: caption.start,
        duration: CAST_LIFT_SECONDS,
        from: { opacity: 0 },
        to: { opacity: 1 }
      });
    }
  }

  return program;
}

/**
 * Which mouth-frame image should be visible on a lip-synced portrait at `time`.
 * Pure helper so tests and the runtime stay identical.
 */
export function mouthVisibilityAt(elapsedSeconds, mouthFps = DEFAULT_MOUTH_FPS) {
  return mouthIndexAtSeconds(elapsedSeconds, mouthFps);
}

/**
 * Browser-side runtime. Implements the slice of the GSAP timeline API the
 * HyperFrames runtime calls, and applies the program on every seek.
 */
export function renderTimelineRuntime(program) {
  return `(() => {
  const PROGRAM = ${JSON.stringify(program)};
  const MOUTH_PATTERN = [0, 1, 2, 1];
  const DEFAULT_MOUTH_FPS = ${DEFAULT_MOUTH_FPS};

  ${easeOutCubic.toString()}

  ${sampleTween.toString()}

  ${round.toString()}

  function mouthIndexAtSeconds(elapsedSeconds, mouthFps) {
    const fps = mouthFps === undefined ? DEFAULT_MOUTH_FPS : mouthFps;
    const state = Math.floor(Math.max(0, elapsedSeconds) * fps);
    return MOUTH_PATTERN[state % MOUTH_PATTERN.length];
  }

  const targets = new Map();
  function resolve(selector) {
    if (!targets.has(selector)) {
      targets.set(selector, Array.from(document.querySelectorAll(selector)));
    }
    return targets.get(selector);
  }

  function applyMouthAt(time) {
    const portraits = document.querySelectorAll('.cast .portrait[data-mouth-sync="true"]');
    for (const portrait of portraits) {
      const cast = portrait.closest(".cast");
      if (!cast) continue;
      const start = Number(cast.getAttribute("data-start"));
      if (!Number.isFinite(start)) continue;
      const index = mouthIndexAtSeconds(Math.max(0, time - start));
      for (const img of portrait.querySelectorAll("img[data-mouth-index]")) {
        const mouthIndex = Number(img.getAttribute("data-mouth-index"));
        img.style.opacity = mouthIndex === index ? "1" : "0";
      }
    }
  }

  function applyAt(time) {
    for (const tween of PROGRAM) {
      const state = sampleTween(tween, time);
      for (const element of resolve(tween.selector)) {
        if (state.opacity !== undefined) element.style.opacity = String(state.opacity);
        const x = state.x ?? 0;
        const y = state.y ?? 0;
        const scale = state.scale ?? 1;
        const scaleX = state.scaleX ?? scale;
        const scaleY = state.scaleY ?? scale;
        if (
          state.x !== undefined ||
          state.y !== undefined ||
          state.scale !== undefined ||
          state.scaleX !== undefined ||
          state.scaleY !== undefined
        ) {
          element.style.transform =
            "translate(" + x + "px," + y + "px) scale(" + scaleX + "," + scaleY + ")";
        }
      }
    }
    applyMouthAt(time);
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
