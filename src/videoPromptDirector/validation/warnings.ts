import type { H3CreativeIr } from "../schema.js";
import { finalizeValidation, issue, type H3Issue, type H3ValidationResult } from "./types.js";

/**
 * Feasible H3 warnings (H3-W001..W007). Never hard-fail validation.
 */
export function validateH3Warnings(ir: H3CreativeIr): H3ValidationResult {
  const issues: H3Issue[] = [];

  // H3-W001: 5 seconds with 3+ shots
  if (ir.target.duration <= 5 && ir.shots.length >= 3) {
    issues.push(issue(
      "H3-W001",
      "3 or more shots in 5 seconds or less may be hard to read",
      "warning",
      ["shots"]
    ));
  }

  // H3-W002: too many major action clauses in one shot
  for (const [index, shot] of ir.shots.entries()) {
    const clauses = shot.visual.split(/[.;]/).map((part) => part.trim()).filter(Boolean);
    if (clauses.length >= 4) {
      issues.push(issue(
        "H3-W002",
        `shot ${index + 1} packs many primary actions into one beat`,
        "warning",
        ["shots", index, "visual"]
      ));
    }
  }

  // H3-W003: static camera vs push-in conflict in sentence
  for (const [index, shot] of ir.shots.entries()) {
    if (!shot.camera) continue;
    const sentence = `${shot.camera.sentence ?? ""} ${shot.visual}`.toLowerCase();
    const staticLike = shot.camera.type === "static" || shot.camera.type === "hold";
    const pushLike = shot.camera.type === "push_in" || shot.camera.type === "zoom_in";
    if (staticLike && /\b(push(?:es)? in|zoom(?:s)? in)\b/.test(sentence)) {
      issues.push(issue(
        "H3-W003",
        `shot ${index + 1} mixes static camera with push/zoom-in language`,
        "warning",
        ["shots", index, "camera"]
      ));
    }
    if (pushLike && /\b(static|hold(?:s)? a static)\b/.test(sentence)) {
      issues.push(issue(
        "H3-W003",
        `shot ${index + 1} mixes push/zoom camera with static language`,
        "warning",
        ["shots", index, "camera"]
      ));
    }
  }

  // H3-W004: dialogue too long for duration
  const totalDialogueChars = ir.shots.reduce((sum, shot) => sum + (shot.dialogue?.text.length ?? 0), 0);
  const budget = ir.target.duration * 12; // rough spoken-char budget
  if (totalDialogueChars > budget) {
    issues.push(issue(
      "H3-W004",
      "dialogue length may be long for the target duration",
      "warning",
      ["shots"]
    ));
  }

  // H3-W005: subject appearance wording drifts across shots
  if (ir.subjects.length > 0) {
    const descriptions = ir.shots.map((shot) => shot.visual.toLowerCase());
    for (const subject of ir.subjects) {
      const tokens = subject.description.toLowerCase().split(/\s+/).filter((token) => token.length > 3);
      if (tokens.length === 0) continue;
      const hits = descriptions.filter((visual) => tokens.some((token) => visual.includes(token)));
      if (hits.length >= 2) {
        const first = hits[0]!;
        const drifted = hits.some((visual) => {
          // crude drift: clothing color words flip
          const colors = ["black", "white", "red", "blue", "green", "yellow", "brown", "gray", "grey"];
          const firstColors = colors.filter((color) => first.includes(color));
          const nextColors = colors.filter((color) => visual.includes(color));
          return firstColors.length > 0 && nextColors.length > 0
            && firstColors.some((color) => !nextColors.includes(color));
        });
        if (drifted) {
          issues.push(issue(
            "H3-W005",
            `subject '${subject.id}' appearance cues appear to change across shots`,
            "warning",
            ["subjects"]
          ));
        }
      }
    }
  }

  // H3-W006: music enabled while soundscape insists on complete silence
  if (ir.sound.music.enabled) {
    const soundscape = ir.sound.soundscape.toLowerCase();
    if (/\b(complete silence|total silence|no sound|absolute silence)\b/.test(soundscape)) {
      issues.push(issue(
        "H3-W006",
        "non-diegetic music is enabled while soundscape requests complete silence",
        "warning",
        ["sound"]
      ));
    }
  }

  // H3-W007: first-last mode with intermediate cuts
  if (ir.target.mode === "first-last" && ir.shots.length > 1) {
    issues.push(issue(
      "H3-W007",
      "first-last generation usually works better as a continuous transition without intermediate cuts",
      "warning",
      ["shots"]
    ));
  }

  return finalizeValidation(issues);
}
