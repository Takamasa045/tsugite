export const SKATE_CAM_PRESET = "skate-cam-16x9";

export function resolveSkateCamPresentation(manifest) {
  const presentation = manifest.presentation ?? {};
  const firstClipDuration = Number.isFinite(presentation.timeline_first_clip_duration_seconds)
    ? presentation.timeline_first_clip_duration_seconds
    : manifest.clips?.[0]?.duration ?? 0;
  const clipDuration = (manifest.clips ?? []).reduce((sum, clip) => sum + clip.duration, 0);
  const totalDuration = Number.isFinite(presentation.timeline_total_duration_seconds)
    ? presentation.timeline_total_duration_seconds
    : clipDuration;

  return {
    title: presentation.title ?? "SKATE SESSION",
    riderName: presentation.rider_name ?? "",
    subtitle: presentation.subtitle ?? "URBAN LINE / TAKE 01–02",
    location: presentation.location ?? "CITY SPOT",
    timelineOffsetSeconds: Number.isFinite(presentation.timeline_offset_seconds)
      ? Math.max(0, presentation.timeline_offset_seconds)
      : 0,
    afterimageEffects: Array.isArray(presentation.afterimage_effects)
      ? presentation.afterimage_effects.filter(isValidAfterimageEffect)
      : [],
    rotoscopeEffects: Array.isArray(presentation.rotoscope_effects)
      ? presentation.rotoscope_effects.filter(isValidRotoscopeEffect)
      : [],
    actionTextEffects: Array.isArray(presentation.action_text_effects)
      ? presentation.action_text_effects.filter(isValidActionTextEffect)
      : [],
    doodleEffects: Array.isArray(presentation.doodle_effects)
      ? presentation.doodle_effects.filter(isValidDoodleEffect)
      : [],
    firstClipDuration,
    totalDuration: Math.max(totalDuration, manifest.meta?.target_duration_seconds ?? 0)
  };
}

function isValidAfterimageEffect(effect) {
  return (
    effect &&
    typeof effect.id === "string" &&
    typeof effect.asset_id === "string" &&
    Number.isFinite(effect.start) &&
    Number.isFinite(effect.end) &&
    effect.end > effect.start
  );
}

function isValidRotoscopeEffect(effect) {
  return (
    effect &&
    typeof effect.id === "string" &&
    typeof effect.cream_asset_id === "string" &&
    typeof effect.red_asset_id === "string" &&
    ["ledge", "jump", "stairs", "rail"].includes(effect.kind) &&
    Number.isFinite(effect.start) &&
    Number.isFinite(effect.end) &&
    effect.end > effect.start &&
    Number.isFinite(effect.impact_time) &&
    effect.impact_time >= effect.start &&
    effect.impact_time <= effect.end
  );
}

function isValidActionTextEffect(effect) {
  return (
    effect &&
    typeof effect.id === "string" &&
    typeof effect.label === "string" &&
    effect.label.trim().length > 0 &&
    ["ledge", "jump", "stairs", "rail"].includes(effect.kind) &&
    Number.isFinite(effect.start) &&
    Number.isFinite(effect.end) &&
    effect.end > effect.start &&
    (effect.x_percent === undefined ||
      (Number.isFinite(effect.x_percent) && effect.x_percent >= 0 && effect.x_percent <= 100)) &&
    (effect.y_percent === undefined ||
      (Number.isFinite(effect.y_percent) && effect.y_percent >= 0 && effect.y_percent <= 100))
  );
}

function isValidDoodleEffect(effect) {
  return (
    effect &&
    typeof effect.id === "string" &&
    ["title", "ledge", "jump", "stairs", "rail"].includes(effect.kind) &&
    (effect.phase === undefined || ["trick", "landing"].includes(effect.phase)) &&
    Number.isFinite(effect.start) &&
    Number.isFinite(effect.end) &&
    effect.end > effect.start
  );
}
