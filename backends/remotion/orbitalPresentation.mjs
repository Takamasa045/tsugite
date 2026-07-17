export const ORBITAL_SHOWREEL_PRESET = "orbital-showreel-16x9";

export const ORBITAL_SCENES = [
  { id: "hook", start: 0, duration: 3 },
  { id: "orbit", start: 3, duration: 3 },
  { id: "feature-story", start: 6, duration: 5 },
  { id: "feature-character", start: 11, duration: 5 },
  { id: "feature-explainer", start: 16, duration: 5 },
  { id: "proof", start: 21, duration: 5 },
  { id: "outro", start: 26, duration: 4 }
];

export function resolveOrbitalShowreel(manifest) {
  const clips = manifest.clips ?? [];
  const clipsById = new Map(clips.map((clip) => [clip.id, clip]));
  const configured = Array.isArray(manifest.presentation?.featured)
    ? manifest.presentation.featured
    : [];
  const featured = configured.map((entry) => {
    const clip = clipsById.get(entry.clip_id);
    if (!clip) throw new Error(`orbital showreel feature references missing clip '${entry.clip_id}'`);
    return {
      clip,
      label: entry.label,
      counter: entry.counter,
      accent: entry.accent ?? "#e8a84e"
    };
  });

  if (clips.length < 3) throw new Error("orbital showreel requires at least three clips");
  if (featured.length !== 3) throw new Error("orbital showreel requires exactly three featured clips");

  return { clips, featured };
}
