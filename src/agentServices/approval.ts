import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { AGENT_SERVICE_ISSUE_CODES, agentServiceError } from "./errors.js";

export const APPROVAL_PURPOSE = "agent-service-tool-call" as const;
export const APPROVAL_SCHEMA_VERSION = 1 as const;

const approvalArtifactSchema = z.object({
  schema_version: z.literal(APPROVAL_SCHEMA_VERSION),
  purpose: z.literal(APPROVAL_PURPOSE),
  service_id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
  tool: z.string().regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/),
  arguments_digest: z.string().regex(/^[a-f0-9]{64}$/),
  expires_at: z.string().datetime({ offset: true }),
  nonce: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{7,127}$/),
  approval_digest: z.string().regex(/^[a-f0-9]{64}$/)
});

export type ApprovalArtifact = z.infer<typeof approvalArtifactSchema>;

export type ApprovalCreateInput = {
  serviceId: string;
  tool: string;
  arguments: unknown;
  expiresAt: Date | string;
  nonce?: string;
};

export type ApprovalVerifyInput = {
  serviceId: string;
  tool: string;
  arguments: unknown;
  artifact: unknown;
  now?: Date;
  consumed?: ApprovalConsumptionStore;
};

export type ApprovalConsumptionStore = {
  has(digest: string): boolean;
  add(digest: string): void;
};

export function createInMemoryApprovalStore(): ApprovalConsumptionStore {
  const used = new Set<string>();
  return {
    has: (digest) => used.has(digest),
    add: (digest) => {
      used.add(digest);
    }
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function digestArguments(args: unknown): string {
  return sha256Hex(canonicalJson(args ?? {}));
}

export function createApprovalArtifact(input: ApprovalCreateInput): ApprovalArtifact {
  const expiresAt = typeof input.expiresAt === "string"
    ? input.expiresAt
    : input.expiresAt.toISOString();
  const nonce = input.nonce ?? randomBytes(16).toString("hex");
  const payload = {
    schema_version: APPROVAL_SCHEMA_VERSION,
    purpose: APPROVAL_PURPOSE,
    service_id: input.serviceId,
    tool: input.tool,
    arguments_digest: digestArguments(input.arguments),
    expires_at: expiresAt,
    nonce
  } as const;
  const approval_digest = digestApprovalPayload(payload);
  return { ...payload, approval_digest };
}

export function digestApprovalPayload(
  payload: Omit<ApprovalArtifact, "approval_digest">
): string {
  return sha256Hex(canonicalJson(payload));
}

/**
 * Verify a human approval artifact for a side-effect tool call.
 * Fail closed on missing, mismatched, expired, tampered, or replayed artifacts.
 * `--yes` alone is never accepted by this contract.
 */
export function verifyApprovalArtifact(input: ApprovalVerifyInput): ApprovalArtifact {
  if (input.artifact == null) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalRequired,
      "this tool requires an explicit human approval artifact"
    );
  }

  const parsed = approvalArtifactSchema.safeParse(input.artifact);
  if (!parsed.success) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalInvalid,
      "approval artifact is invalid or malformed"
    );
  }
  const artifact = parsed.data;
  const expectedDigest = digestApprovalPayload({
    schema_version: artifact.schema_version,
    purpose: artifact.purpose,
    service_id: artifact.service_id,
    tool: artifact.tool,
    arguments_digest: artifact.arguments_digest,
    expires_at: artifact.expires_at,
    nonce: artifact.nonce
  });
  if (artifact.approval_digest !== expectedDigest) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalInvalid,
      "approval artifact digest does not match payload"
    );
  }

  if (artifact.service_id !== input.serviceId || artifact.tool !== input.tool) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalMismatch,
      "approval artifact does not match the requested service or tool"
    );
  }

  const argsDigest = digestArguments(input.arguments);
  if (artifact.arguments_digest !== argsDigest) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalMismatch,
      "approval artifact does not match the requested arguments"
    );
  }

  const now = input.now ?? new Date();
  const expiresAt = Date.parse(artifact.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.approvalExpired,
      "approval artifact has expired"
    );
  }

  const store = input.consumed;
  if (store) {
    if (store.has(artifact.approval_digest)) {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.approvalReplay,
        "approval artifact was already consumed"
      );
    }
    store.add(artifact.approval_digest);
  }

  return artifact;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
