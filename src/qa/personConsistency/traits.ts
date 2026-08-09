/**
 * Map H3 preservation levels to required/advisory trait requirements.
 * Unspecified preservation never implies face recognition.
 */
import type {
  PersonTrait,
  PreservationLevel,
  TraitRequirement
} from "./schema.js";

const TRAITS: readonly PersonTrait[] = ["identity", "clothing", "hairstyle"];

export type SubjectPreservation = {
  identity?: PreservationLevel;
  clothing?: PreservationLevel;
  hairstyle?: PreservationLevel;
};

/**
 * strict -> required, loose -> advisory.
 * Omitted traits are not evaluated (no implicit face recognition).
 */
export function mapPreservationToTraitRequirements(
  preservation: SubjectPreservation | undefined
): TraitRequirement[] {
  if (!preservation) return [];
  const requirements: TraitRequirement[] = [];
  for (const trait of TRAITS) {
    const level = preservation[trait];
    if (!level) continue;
    requirements.push({
      trait,
      level: level === "strict" ? "required" : "advisory",
      preservation: level
    });
  }
  return requirements;
}

export function requiredTraits(requirements: readonly TraitRequirement[]): PersonTrait[] {
  return requirements.filter((item) => item.level === "required").map((item) => item.trait);
}

export function advisoryTraits(requirements: readonly TraitRequirement[]): PersonTrait[] {
  return requirements.filter((item) => item.level === "advisory").map((item) => item.trait);
}
