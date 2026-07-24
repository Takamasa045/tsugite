import { ArticleDialogue } from "./dialogue.js";
import { MiraichiLastCall } from "./miraichiLastCall.js";
import { ORBITAL_SHOWREEL_PRESET } from "./orbitalPresentation.mjs";
import { OrbitalShowreel } from "./orbitalShowreel.js";
import { ARTICLE_DIALOGUE_PRESET } from "./presentation.mjs";
import { StreetDialogue } from "./streetDialogue.js";
import { STREET_DIALOGUE_PRESET } from "./streetPresentation.mjs";
import { SUMMER_CAMP_GENERATED_LANDSCAPE_PRESET, SummerCampGeneratedLandscape } from "./summerCampGeneratedLandscape.js";

export const PRESET_REGISTRY = Object.freeze([
  Object.freeze({ id: ARTICLE_DIALOGUE_PRESET, handler: ArticleDialogue }),
  Object.freeze({ id: STREET_DIALOGUE_PRESET, handler: StreetDialogue }),
  Object.freeze({ id: SUMMER_CAMP_GENERATED_LANDSCAPE_PRESET, handler: SummerCampGeneratedLandscape }),
  Object.freeze({ id: "miraichi-lastcall-9x16", handler: MiraichiLastCall }),
  Object.freeze({ id: ORBITAL_SHOWREEL_PRESET, handler: OrbitalShowreel })
]);

export const REMOTION_PRESET_REGISTRY = PRESET_REGISTRY;

const presetsById = new Map(PRESET_REGISTRY.map((entry) => [entry.id, entry]));

if (presetsById.size !== PRESET_REGISTRY.length) {
  throw new Error("Remotion preset registry contains duplicate ids");
}

export function resolveRemotionPreset(id) {
  return presetsById.get(id);
}
