/**
 * Frozen PO-8 RC fixture ids and loader (shared by rehearsal + module evidence).
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PO8_FIXTURE_IDS = [
  "legacy-h3",
  "standalone-v2",
  "lyric-mv",
  "identity-phase-a-e",
  "gate2-auto-pass-cascade",
  "job-revision-submission-unknown",
  "recovery-unknown-price",
  "mission-tree-finalize-learning"
] as const;

export type Po8FixtureId = (typeof PO8_FIXTURE_IDS)[number];

export type Po8FixtureManifest = {
  schema_version: 1;
  fixture_id: Po8FixtureId;
  kind: string;
  description: string;
  project: Record<string, unknown>;
  identity?: {
    locked_true_implies_verified: false;
    definition_confirmation_inferred_from_gate1: false;
  };
  safety_expectations: string[];
  golden_digests?: Record<string, string>;
};

const REPO_FIXTURE_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../test/fixtures/production-control/po8"
);

export async function loadPo8Fixture(fixtureId: Po8FixtureId): Promise<Po8FixtureManifest> {
  const path = join(REPO_FIXTURE_ROOT, `${fixtureId}.fixture.json`);
  const raw = JSON.parse(await readFile(path, "utf8")) as Po8FixtureManifest;
  if (raw.fixture_id !== fixtureId) {
    throw new Error(`fixture id mismatch: expected ${fixtureId}, got ${raw.fixture_id}`);
  }
  return raw;
}
