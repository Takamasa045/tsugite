import {
  contractFragmentIndexSchema,
  contractSetSchema,
  digestSchema,
  safeIdSchema,
  type ContractFragmentIndex,
  type ContractFragmentRef,
  type ContractSet,
  type ContractSetV1
} from "./schema.js";
import { assertSafeJsonValue, sha256Canonical } from "./canonical.js";
import { pcError } from "./errors.js";

export type ContractSlot = ContractFragmentRef["slot"];
export type ContractSetSlot = "assets" | "identity" | "music" | "lyrics";

export type ProvenContractFragment = {
  kind: Exclude<ContractFragmentRef["kind"], "whole">;
  fragment_id: string;
  value: unknown;
};

export type ContractRegistration<T = unknown> = {
  slot: ContractSlot;
  contract_id: string;
  revision: number;
  artifact_id: string;
  payload: T;
  digest?: string;
  fragments?: ProvenContractFragment[];
};

export type RegisteredContract<T = unknown> = ContractRegistration<T> & {
  digest: string;
  fragment_index: ContractFragmentIndex;
};

function contractDigest<T>(registration: ContractRegistration<T>): string {
  const payloadDigest = sha256Canonical(registration.payload);
  const embeddedValue = registration.payload && typeof registration.payload === "object" && !Array.isArray(registration.payload)
    ? (registration.payload as Record<string, unknown>).digest ?? (registration.payload as Record<string, unknown>).root_digest
    : undefined;
  const embedded = typeof embeddedValue === "string"
    && digestSchema.safeParse(embeddedValue).success
    ? embeddedValue
    : undefined;
  return embedded ?? payloadDigest;
}

function structuralContractDigest<T>(registration: ContractRegistration<T>): string {
  return sha256Canonical({
    slot: registration.slot,
    contract_id: registration.contract_id,
    revision: registration.revision,
    artifact_id: registration.artifact_id,
    payload: registration.payload
  });
}

function wholeFragment(registration: ContractRegistration, digest: string): ContractFragmentRef {
  return {
    slot: registration.slot,
    contract_id: safeIdSchema.parse(registration.contract_id),
    revision: registration.revision,
    kind: "whole",
    fragment_id: `${registration.contract_id}.whole.${registration.revision}`,
    digest
  };
}

export function buildContractFragmentIndex(
  registration: ContractRegistration
): ContractFragmentIndex {
  safeIdSchema.parse(registration.contract_id);
  safeIdSchema.parse(registration.artifact_id);
  if (!Number.isSafeInteger(registration.revision) || registration.revision < 0) {
    throw pcError("PC_FRAGMENT_INVALID", "contract revision must be a non-negative integer");
  }
  assertSafeJsonValue(registration.payload, "contract payload");
  const computedDigest = contractDigest(registration);
  const structuralDigest = structuralContractDigest(registration);
  if (registration.digest && ![computedDigest, structuralDigest].includes(registration.digest)) {
    throw pcError("PC_FRAGMENT_INVALID", "contract digest does not match the registered payload");
  }
  const digest = registration.digest ?? computedDigest;

  const fragments: ContractFragmentRef[] = [];
  if (!registration.fragments || registration.fragments.length === 0) {
    fragments.push(wholeFragment(registration, digest));
  } else {
    const seen = new Set<string>();
    for (const fragment of registration.fragments) {
      const fragmentId = safeIdSchema.parse(fragment.fragment_id);
      if (seen.has(fragmentId)) {
        throw pcError("PC_FRAGMENT_INVALID", "fragment ids must be unique");
      }
      seen.add(fragmentId);
      assertSafeJsonValue(fragment.value, `contract fragment ${fragmentId}`);
      fragments.push({
        slot: registration.slot,
        contract_id: registration.contract_id,
        revision: registration.revision,
        kind: fragment.kind,
        fragment_id: fragmentId,
        digest: sha256Canonical(fragment.value)
      });
    }
  }

  const base = {
    schema_version: 1 as const,
    slot: registration.slot,
    contract_id: registration.contract_id,
    revision: registration.revision,
    fragments
  };
  const index = {
    ...base,
    digest: sha256Canonical(base)
  };
  return contractFragmentIndexSchema.parse(index);
}

export function createContractSet(input: {
  production_id: string;
  revision: number;
  contracts: Array<{
    slot: ContractSetSlot;
    contract_id: string;
    contract_revision: number;
    artifact_id: string;
    digest: string;
  }>;
}): ContractSetV1 {
  const slots = new Set<string>();
  for (const contract of input.contracts) {
    if (slots.has(contract.slot)) throw pcError("PC_CONTRACT_INVALID", "contract slots must be unique");
    slots.add(contract.slot);
  }
  const base = {
    schema_version: 1 as const,
    production_id: safeIdSchema.parse(input.production_id),
    revision: input.revision,
    contracts: input.contracts.map((contract) => ({
      slot: contract.slot,
      contract_id: safeIdSchema.parse(contract.contract_id),
      contract_revision: contract.contract_revision,
      artifact_id: safeIdSchema.parse(contract.artifact_id),
      digest: digestSchema.parse(contract.digest)
    }))
  };
  const result = contractSetSchema.parse({ ...base, digest: sha256Canonical(base) });
  return result;
}

export class ContractRegistry {
  private readonly contracts = new Map<string, RegisteredContract>();

  register<T>(registration: ContractRegistration<T>): RegisteredContract<T> {
    const contractId = safeIdSchema.parse(registration.contract_id);
    const key = `${contractId}:${registration.revision}`;
    if (this.contracts.has(key)) throw pcError("PC_CONTRACT_INVALID", "contract revision is already registered");
    const digest = registration.digest ?? contractDigest(registration);
    if (registration.digest && ![contractDigest(registration), structuralContractDigest(registration)].includes(registration.digest)) {
      throw pcError("PC_CONTRACT_INVALID", "contract digest does not match the registered payload");
    }
    const fragmentIndex = buildContractFragmentIndex({ ...registration, digest });
    const registered = { ...registration, digest, fragment_index: fragmentIndex } as RegisteredContract<T>;
    this.contracts.set(key, registered as RegisteredContract);
    return registered;
  }

  get(contractId: string, revision: number): RegisteredContract | undefined {
    return this.contracts.get(`${contractId}:${revision}`);
  }

  require(contractId: string, revision: number): RegisteredContract {
    const value = this.get(contractId, revision);
    if (!value) throw pcError("PC_CONTRACT_INVALID", "contract revision is not registered");
    return value;
  }

  list(): RegisteredContract[] {
    return [...this.contracts.values()].sort((left, right) =>
      `${left.slot}:${left.contract_id}:${left.revision}`.localeCompare(`${right.slot}:${right.contract_id}:${right.revision}`)
    );
  }

  resolve(ref: ContractFragmentRef): boolean {
    const registered = this.get(ref.contract_id, ref.revision);
    if (!registered) return false;
    return registered.fragment_index.fragments.some((candidate) =>
      candidate.slot === ref.slot
      && candidate.contract_id === ref.contract_id
      && candidate.revision === ref.revision
      && candidate.kind === ref.kind
      && candidate.fragment_id === ref.fragment_id
      && candidate.digest === ref.digest
    );
  }

  buildSet(productionId: string, revision = 0, slots?: ContractSetSlot[]): ContractSet {
    const wanted = slots ? new Set(slots) : new Set<ContractSetSlot>(["assets", "identity", "music", "lyrics"]);
    const entries = this.list()
      .filter((contract) => {
        const slot = contract.slot === "identity-definition" ? "identity" : contract.slot;
        return wanted.has(slot as ContractSetSlot);
      })
      .map((contract) => ({
        slot: (contract.slot === "identity-definition" ? "identity" : contract.slot) as ContractSetSlot,
        contract_id: contract.contract_id,
        contract_revision: contract.revision,
        artifact_id: contract.artifact_id,
        digest: contract.digest
      }));
    return createContractSet({ production_id: productionId, revision, contracts: entries });
  }
}

export function contractSetDigest(contractSet: ContractSet): string {
  const { digest, ...base } = contractSet;
  const expected = sha256Canonical(base);
  if (expected !== digest) throw pcError("PC_CONTRACT_INVALID", "contract set digest mismatch");
  return digest;
}
