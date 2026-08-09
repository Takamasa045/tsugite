/**
 * Compile H3 Creative IR subjects/preservation + shot expectations into QA requirements.
 */
import { sha256Canonical } from "../../h3/hash.js";
import type { Issue, Result } from "../../types.js";
import type { SemanticQaAdapterInput } from "./adapterContract.js";
import { buildSamplingPlan, type ShotTiming } from "./sampling.js";
import type {
  EvaluationBasis,
  FaceVisibility,
  NormalizedRegion,
  PersonConsistencyPolicyV1,
  PersonConsistencyStage,
  PersonTrait,
  SubjectExpectation,
  TraitRequirement,
  Visibility
} from "./schema.js";
import { mapPreservationToTraitRequirements, requiredTraits, advisoryTraits } from "./traits.js";

export type CompileSubjectInput = {
  id: string;
  source_asset?: string;
  preservation?: {
    identity?: "strict" | "loose";
    clothing?: "strict" | "loose";
    hairstyle?: "strict" | "loose";
  };
  consistency?: {
    enabled: boolean;
    reference_region?: NormalizedRegion;
  };
};

export type CompileShotInput = {
  id: string;
  start_ms: number;
  end_ms: number;
  subject_expectations?: SubjectExpectation[];
};

export type CompileAssetInput = {
  id: string;
  path: string;
  /** Precomputed sha256 of asset bytes when available. */
  sha256?: string;
};

export type CompiledSubjectRequirement = {
  subject_id: string;
  enabled: boolean;
  basis: EvaluationBasis;
  traits: TraitRequirement[];
  required_traits: PersonTrait[];
  advisory_traits: PersonTrait[];
  reference_asset_id?: string;
  reference_asset_hash?: string;
  reference_region?: NormalizedRegion;
  /** True when multi-face reference ambiguity blocks automatic evaluation. */
  reference_ambiguous: boolean;
  blocked_reasons: string[];
};

export type CompiledShotExpectation = {
  shot_id: string;
  start_ms: number;
  end_ms: number;
  expectations: Array<{
    subject_id: string;
    visibility: Visibility;
    face_visibility: FaceVisibility;
  }>;
};

export type PersonConsistencyCompileResult = {
  subjects: CompiledSubjectRequirement[];
  shots: CompiledShotExpectation[];
  sampling_plan: ReturnType<typeof buildSamplingPlan>;
  input_digest: string;
  /** Subjects that participate in QA (enabled + at least one trait). */
  active_subjects: CompiledSubjectRequirement[];
};

export type CompilePersonConsistencyOptions = {
  policy: PersonConsistencyPolicyV1;
  stage: PersonConsistencyStage;
  subjects: readonly CompileSubjectInput[];
  shots: readonly CompileShotInput[];
  assets?: readonly CompileAssetInput[];
  /**
   * When a reference image is known to contain multiple faces and no
   * reference_region is provided, mark reference_ambiguous.
   */
  multiFaceReferenceSubjects?: ReadonlySet<string>;
};

/**
 * Compile preservation + consistency config into trait requirements and sampling plan.
 * - preservation unspecified or consistency disabled => no face recognition for that subject
 * - source_asset present => basis reference; else relative-only
 * - multi-face reference without reference_region => reference_ambiguous (blocked/review)
 */
export function compilePersonConsistencyRequirements(
  options: CompilePersonConsistencyOptions
): Result<{ compiled: PersonConsistencyCompileResult }> {
  if (!options.policy.enabled) {
    return {
      ok: true,
      issues: [],
      compiled: {
        subjects: [],
        shots: [],
        sampling_plan: [],
        input_digest: sha256Canonical({ stage: options.stage, enabled: false }),
        active_subjects: []
      }
    };
  }

  if (!options.policy.stages.includes(options.stage)) {
    return {
      ok: true,
      issues: [],
      compiled: {
        subjects: [],
        shots: [],
        sampling_plan: [],
        input_digest: sha256Canonical({ stage: options.stage, stages: options.policy.stages }),
        active_subjects: []
      }
    };
  }

  const assetHashes = new Map(
    (options.assets ?? []).map((asset) => [asset.id, asset.sha256] as const)
  );
  const issues: Issue[] = [];
  const subjects: CompiledSubjectRequirement[] = [];

  for (const subject of options.subjects) {
    const consistencyEnabled = subject.consistency?.enabled === true;
    const traits = mapPreservationToTraitRequirements(subject.preservation);
    // Implicit: no preservation and/or consistency not enabled => no face recognition.
    if (!consistencyEnabled || traits.length === 0) {
      subjects.push({
        subject_id: subject.id,
        enabled: false,
        basis: subject.source_asset ? "reference" : "relative-only",
        traits: [],
        required_traits: [],
        advisory_traits: [],
        reference_ambiguous: false,
        blocked_reasons: []
      });
      continue;
    }

    const basis: EvaluationBasis = subject.source_asset ? "reference" : "relative-only";
    const blocked_reasons: string[] = [];
    let reference_ambiguous = false;
    const multiFace =
      options.multiFaceReferenceSubjects?.has(subject.id)
      || options.multiFaceReferenceSubjects?.has(subject.source_asset ?? "");

    if (basis === "reference" && multiFace && !subject.consistency?.reference_region) {
      reference_ambiguous = true;
      blocked_reasons.push("reference_ambiguous");
    }

    const reference_asset_hash = subject.source_asset
      ? assetHashes.get(subject.source_asset)
      : undefined;

    subjects.push({
      subject_id: subject.id,
      enabled: true,
      basis,
      traits,
      required_traits: requiredTraits(traits),
      advisory_traits: advisoryTraits(traits),
      ...(subject.source_asset ? { reference_asset_id: subject.source_asset } : {}),
      ...(reference_asset_hash ? { reference_asset_hash } : {}),
      ...(subject.consistency?.reference_region
        ? { reference_region: subject.consistency.reference_region }
        : {}),
      reference_ambiguous,
      blocked_reasons
    });
  }

  const shotTimings: ShotTiming[] = [];
  const shots: CompiledShotExpectation[] = [];
  for (const shot of options.shots) {
    if (shot.end_ms <= shot.start_ms) {
      issues.push({
        code: "person_qa.shot_timing_invalid",
        message: `shot '${shot.id}' has non-positive duration`,
        path: shot.id
      });
      continue;
    }
    shotTimings.push({ id: shot.id, start_ms: shot.start_ms, end_ms: shot.end_ms });
    shots.push({
      shot_id: shot.id,
      start_ms: shot.start_ms,
      end_ms: shot.end_ms,
      expectations: (shot.subject_expectations ?? []).map((expectation) => ({
        subject_id: expectation.subject_id,
        visibility: expectation.visibility,
        face_visibility: expectation.face_visibility
      }))
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  const sampling_plan = buildSamplingPlan(
    shotTimings,
    options.policy.evidence.frames_per_shot
  );

  const active_subjects = subjects.filter((subject) => subject.enabled);
  const input_digest = sha256Canonical({
    stage: options.stage,
    policy: {
      adapter: options.policy.adapter,
      stages: options.policy.stages,
      evidence: options.policy.evidence,
      external: options.policy.external
    },
    subjects: active_subjects.map((subject) => ({
      subject_id: subject.subject_id,
      basis: subject.basis,
      traits: subject.traits,
      reference_asset_id: subject.reference_asset_id,
      reference_asset_hash: subject.reference_asset_hash,
      reference_region: subject.reference_region,
      reference_ambiguous: subject.reference_ambiguous
    })),
    shots,
    sampling_plan
  });

  return {
    ok: true,
    issues: [],
    compiled: {
      subjects,
      shots,
      sampling_plan,
      input_digest,
      active_subjects
    }
  };
}

export function toSemanticQaAdapterInput(options: {
  compiled: PersonConsistencyCompileResult;
  stage: PersonConsistencyStage;
  media?: SemanticQaAdapterInput["media"];
}): SemanticQaAdapterInput {
  return {
    stage: options.stage,
    input_digest: options.compiled.input_digest,
    sampling_plan: options.compiled.sampling_plan,
    subjects: options.compiled.active_subjects.map((subject) => ({
      subject_id: subject.subject_id,
      required_traits: subject.required_traits,
      advisory_traits: subject.advisory_traits,
      basis: subject.basis,
      ...(subject.reference_asset_hash
        ? { reference_asset_hash: subject.reference_asset_hash }
        : {}),
      ...(subject.reference_region ? { reference_region: subject.reference_region } : {})
    })),
    media: options.media ?? {}
  };
}
