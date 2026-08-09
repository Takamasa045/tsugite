/**
 * Production-safe offline semantic-qa adapters for this phase:
 * - fixture: loads pre-authored observation payload (tests / offline)
 * - manual: validates human-imported evidence without face models
 *
 * No real face models, network, or external APIs.
 */
import type { Issue, Result } from "../../types.js";
import {
  checkRequiredTraitsSupported,
  parseSemanticQaAdapterInput,
  type SemanticQaAdapter,
  type SemanticQaAdapterInput,
  type SemanticQaCapability
} from "./adapterContract.js";
import {
  PERSON_CONSISTENCY_ADAPTER_CLASS,
  PERSON_CONSISTENCY_SCHEMA_VERSION,
  parsePersonConsistencyReport,
  type PersonConsistencyReportV1,
  type PersonObservation,
  type TraitSummary
} from "./schema.js";
import { computeReportBodyDigest } from "./evidence.js";

const FIXTURE_CAPABILITY: SemanticQaCapability = {
  class: PERSON_CONSISTENCY_ADAPTER_CLASS,
  name: "person-consistency-fixture",
  traits: ["identity", "clothing", "hairstyle"],
  multi_subject_tracking: true,
  occlusion_handling: true,
  offline: true,
  model: "fixture",
  version: "1.0.0",
  network_input_scope: "none",
  retains_biometric_embeddings: false,
  cost_estimate: { per_run: 0, notes: "offline fixture; no network" },
  retry_policy: { max_attempts: 0, retryable_codes: [] }
};

const MANUAL_CAPABILITY: SemanticQaCapability = {
  class: PERSON_CONSISTENCY_ADAPTER_CLASS,
  name: "person-consistency-manual",
  traits: ["identity", "clothing", "hairstyle"],
  multi_subject_tracking: true,
  occlusion_handling: true,
  offline: true,
  model: "manual-evidence",
  version: "1.0.0",
  network_input_scope: "none",
  retains_biometric_embeddings: false,
  cost_estimate: { per_run: 0, notes: "manual import; no network" },
  retry_policy: { max_attempts: 0, retryable_codes: [] }
};

export type FixtureObservationSeed = {
  subject_id: string;
  observations: PersonObservation[];
  trait_statuses?: Partial<Record<"identity" | "clothing" | "hairstyle", TraitSummary["status"]>>;
  ambiguity_codes?: string[];
  force_status?: PersonConsistencyReportV1["status"];
  blocked_reasons?: string[];
};

/**
 * Build a valid report from fixture seeds. Does not invent face detections.
 * No face / occluded / offscreen => identity not-evaluable (not failure).
 * Ambiguous multi-person assignment => review/blocked, no auto decision.
 */
export function buildFixtureReport(options: {
  input: SemanticQaAdapterInput;
  seeds: FixtureObservationSeed[];
  capability?: SemanticQaCapability;
  contactSheetRelativePath?: string;
  reportRelativePath: string;
  subjectReferenceHashes?: Record<string, string>;
}): Result<{ report: PersonConsistencyReportV1 }> {
  const capability = options.capability ?? FIXTURE_CAPABILITY;
  const allRequired = options.input.subjects.flatMap((subject) => subject.required_traits);
  const missing = checkRequiredTraitsSupported(capability, allRequired);
  if (missing.length > 0) {
    return { ok: false, issues: missing };
  }

  const seedBySubject = new Map(options.seeds.map((seed) => [seed.subject_id, seed]));
  const subjects: PersonConsistencyReportV1["subjects"] = [];
  const ambiguities: string[] = [];
  const blocked_reasons: string[] = [];
  let status: PersonConsistencyReportV1["status"] = "ok";

  for (const subject of options.input.subjects) {
    const seed = seedBySubject.get(subject.subject_id);
    const observations = seed?.observations ?? [];
    const ambiguity_codes = [...(seed?.ambiguity_codes ?? [])];
    if (ambiguity_codes.includes("ambiguous_assignment")) {
      ambiguities.push(`subject:${subject.subject_id}:ambiguous_assignment`);
      status = status === "blocked" ? "blocked" : "review";
    }
    if (seed?.blocked_reasons?.length) {
      blocked_reasons.push(...seed.blocked_reasons);
      status = "blocked";
    }

    const faceEvaluableCount = observations.filter((item) => item.face_evaluable).length;
    const evaluable_coverage =
      observations.length === 0 ? 0 : faceEvaluableCount / observations.length;

    const traits: TraitSummary[] = [];
    for (const trait of [...subject.required_traits, ...subject.advisory_traits]) {
      const level = subject.required_traits.includes(trait) ? "required" : "advisory";
      let traitStatus: TraitSummary["status"] =
        seed?.trait_statuses?.[trait] ?? (faceEvaluableCount > 0 ? "stable" : "not-evaluable");

      // Identity without evaluable faces is not a failure.
      if (trait === "identity" && faceEvaluableCount === 0) {
        traitStatus = "not-evaluable";
      }

      traits.push({
        trait,
        status: traitStatus,
        level,
        ...(traitStatus === "not-evaluable"
          ? { notes: "no evaluable face observations; not treated as identity failure" }
          : {})
      });
    }

    if (traits.length === 0) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.fixture_invalid",
            message: `fixture subject '${subject.subject_id}' has no traits`
          }
        ]
      };
    }

    // Track assignment evidence for multi-person scenes.
    const trackIds = new Set(
      observations.map((item) => item.track_id).filter((id): id is string => Boolean(id))
    );

    subjects.push({
      subject_id: subject.subject_id,
      basis: subject.basis,
      traits,
      observations,
      evaluable_coverage,
      ambiguity_codes
    });

    if (trackIds.size > 1 && ambiguity_codes.includes("track_crossing")) {
      ambiguities.push(`subject:${subject.subject_id}:track_crossing`);
      if (status === "ok") status = "review";
    }

    // Required trait findings must never leave overall status as a silent "ok".
    // possible-drift => review; required not-evaluable is handled after the loop.
    for (const trait of traits) {
      if (trait.level !== "required") continue;
      if (trait.status === "possible-drift" && status === "ok") {
        status = "review";
      }
    }
  }

  if (subjects.every((subject) => subject.evaluable_coverage === 0) && status === "ok") {
    status = "not_evaluable";
  }

  // If every required trait is not-evaluable and nothing is blocked, treat as not_evaluable.
  if (status === "ok" || status === "review") {
    const requiredTraits = subjects.flatMap((subject) =>
      subject.traits.filter((trait) => trait.level === "required")
    );
    if (
      requiredTraits.length > 0
      && requiredTraits.every((trait) => trait.status === "not-evaluable")
      && ambiguities.length === 0
    ) {
      status = "not_evaluable";
    } else if (
      requiredTraits.some((trait) => trait.status === "possible-drift")
      && status === "ok"
    ) {
      status = "review";
    }
  }

  // force_status must not paper over drift/ambiguity as ok.
  for (const seed of options.seeds) {
    if (seed.force_status === "ok") continue;
    if (seed.force_status === "blocked") status = "blocked";
    if (seed.force_status === "review" && status === "ok") status = "review";
    if (seed.force_status === "not_evaluable" && (status === "ok" || status === "review")) {
      status = "not_evaluable";
    }
  }

  const withoutDigest = {
    schema_version: PERSON_CONSISTENCY_SCHEMA_VERSION,
    stage: options.input.stage,
    status,
    input_digest: options.input.input_digest,
    subject_reference_hashes: options.subjectReferenceHashes ?? {},
    tracks: collectTracks(options.seeds),
    subjects,
    sampling_plan: options.input.sampling_plan,
    provenance: {
      adapter: capability.name,
      adapter_class: PERSON_CONSISTENCY_ADAPTER_CLASS,
      model: capability.model,
      version: capability.version,
      ...(capability.weights_sha256 ? { weights_sha256: capability.weights_sha256 } : {}),
      ...(capability.license ? { license: capability.license } : {}),
      ...(capability.calibration_revision
        ? { calibration_revision: capability.calibration_revision }
        : {}),
      network_used: false,
      network_input_scope: capability.network_input_scope
    },
    artifacts: {
      report_relative_path: options.reportRelativePath,
      ...(options.contactSheetRelativePath
        ? { contact_sheet_relative_path: options.contactSheetRelativePath }
        : {})
    },
    ambiguities,
    blocked_reasons
  } satisfies Omit<PersonConsistencyReportV1, "report_digest">;

  const report: PersonConsistencyReportV1 = {
    ...withoutDigest,
    report_digest: computeReportBodyDigest(withoutDigest as PersonConsistencyReportV1)
  };

  const parsed = parsePersonConsistencyReport(report);
  if (!parsed.ok) {
    return {
      ok: false,
      issues: [{ code: "person_qa.fixture_invalid", message: parsed.message }]
    };
  }

  return { ok: true, issues: [], report: parsed.report };
}

function collectTracks(seeds: FixtureObservationSeed[]): PersonConsistencyReportV1["tracks"] {
  const tracks = new Map<string, { track_id: string; subject_id?: string }>();
  for (const seed of seeds) {
    for (const observation of seed.observations) {
      if (!observation.track_id) continue;
      if (!tracks.has(observation.track_id)) {
        tracks.set(observation.track_id, {
          track_id: observation.track_id,
          subject_id: seed.subject_id
        });
      }
    }
  }
  return [...tracks.values()];
}

export class FixtureSemanticQaAdapter implements SemanticQaAdapter {
  readonly capability = FIXTURE_CAPABILITY;
  private readonly seeds: FixtureObservationSeed[];
  private readonly reportRelativePath: string;
  private readonly contactSheetRelativePath?: string;
  private readonly subjectReferenceHashes?: Record<string, string>;

  constructor(options: {
    seeds: FixtureObservationSeed[];
    reportRelativePath: string;
    contactSheetRelativePath?: string;
    subjectReferenceHashes?: Record<string, string>;
  }) {
    this.seeds = options.seeds;
    this.reportRelativePath = options.reportRelativePath;
    this.contactSheetRelativePath = options.contactSheetRelativePath;
    this.subjectReferenceHashes = options.subjectReferenceHashes;
  }

  async analyze(input: SemanticQaAdapterInput): Promise<Result<{ payload: unknown }>> {
    const parsed = parseSemanticQaAdapterInput(input);
    if (!parsed.ok) return parsed;
    const built = buildFixtureReport({
      input: parsed.input,
      seeds: this.seeds,
      reportRelativePath: this.reportRelativePath,
      contactSheetRelativePath: this.contactSheetRelativePath,
      subjectReferenceHashes: this.subjectReferenceHashes
    });
    if (!built.ok) return built;
    return { ok: true, issues: [], payload: built.report };
  }
}

/**
 * Manual evidence adapter: accepts a pre-validated report payload imported by a human.
 * Does not run any model. Rejects embeddings and unknown fields via schema parse.
 */
export class ManualSemanticQaAdapter implements SemanticQaAdapter {
  readonly capability = MANUAL_CAPABILITY;
  private readonly importedReport: unknown;
  private readonly expectedInputDigest: string;

  constructor(options: { importedReport: unknown; expectedInputDigest: string }) {
    this.importedReport = options.importedReport;
    this.expectedInputDigest = options.expectedInputDigest;
  }

  async analyze(input: SemanticQaAdapterInput): Promise<Result<{ payload: unknown }>> {
    const parsedInput = parseSemanticQaAdapterInput(input);
    if (!parsedInput.ok) return parsedInput;

    const missing = checkRequiredTraitsSupported(
      this.capability,
      parsedInput.input.subjects.flatMap((subject) => subject.required_traits)
    );
    if (missing.length > 0) return { ok: false, issues: missing };

    const parsed = parsePersonConsistencyReport(this.importedReport);
    if (!parsed.ok) {
      return {
        ok: false,
        issues: [{ code: "person_qa.manual_import_invalid", message: parsed.message }]
      };
    }

    if (parsed.report.input_digest !== this.expectedInputDigest) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.input_digest_mismatch",
            message: "manual report input_digest does not match compiled requirements"
          }
        ]
      };
    }

    if (parsed.report.input_digest !== parsedInput.input.input_digest) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.input_digest_mismatch",
            message: "manual report input_digest does not match adapter input"
          }
        ]
      };
    }

    // Never trust analyzer output without project/run digest alignment (already checked).
    if (parsed.report.provenance.network_used) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.manual_network_forbidden",
            message: "manual adapter rejects reports that claim network_used=true"
          }
        ]
      };
    }

    return { ok: true, issues: [], payload: parsed.report };
  }
}

export function resolveSemanticQaAdapter(
  name: string,
  options: {
    seeds?: FixtureObservationSeed[];
    reportRelativePath?: string;
    contactSheetRelativePath?: string;
    subjectReferenceHashes?: Record<string, string>;
    importedReport?: unknown;
    expectedInputDigest?: string;
  } = {}
): Result<{ adapter: SemanticQaAdapter }> {
  if (name === "person-consistency-fixture" || name === "fixture") {
    return {
      ok: true,
      issues: [],
      adapter: new FixtureSemanticQaAdapter({
        seeds: options.seeds ?? [],
        reportRelativePath:
          options.reportRelativePath ?? "qa/person-consistency/gate2/report.json",
        contactSheetRelativePath: options.contactSheetRelativePath,
        subjectReferenceHashes: options.subjectReferenceHashes
      })
    };
  }
  if (name === "person-consistency-manual" || name === "manual") {
    if (options.importedReport === undefined || !options.expectedInputDigest) {
      return {
        ok: false,
        issues: [
          {
            code: "person_qa.manual_adapter_config",
            message: "manual adapter requires importedReport and expectedInputDigest"
          }
        ]
      };
    }
    return {
      ok: true,
      issues: [],
      adapter: new ManualSemanticQaAdapter({
        importedReport: options.importedReport,
        expectedInputDigest: options.expectedInputDigest
      })
    };
  }
  return {
    ok: false,
    issues: [
      {
        code: "person_qa.adapter_unknown",
        message: `unknown semantic-qa adapter '${name}' (external adapters are not connected in this phase)`
      }
    ]
  };
}

export function fixtureCapability(): SemanticQaCapability {
  return { ...FIXTURE_CAPABILITY, traits: [...FIXTURE_CAPABILITY.traits] };
}

export function manualCapability(): SemanticQaCapability {
  return { ...MANUAL_CAPABILITY, traits: [...MANUAL_CAPABILITY.traits] };
}

/** Helper to assert analyzer payload never carries secrets. */
export function assertNoSecretsInPayload(payload: unknown): Issue[] {
  const text = JSON.stringify(payload);
  if (/(api[_-]?key|token|cookie|authorization|secret|password)/i.test(text)) {
    return [
      {
        code: "person_qa.secret_forbidden",
        message: "API keys, tokens, or cookies must not appear in person consistency artifacts"
      }
    ];
  }
  return [];
}
