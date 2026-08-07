import type { AgentServiceDefinition, AgentServiceToolDefinition } from "./registry.js";
import { getServiceTool, looksWriteLikeToolName } from "./registry.js";
import {
  createInMemoryApprovalStore,
  verifyApprovalArtifact,
  type ApprovalConsumptionStore
} from "./approval.js";
import { AGENT_SERVICE_ISSUE_CODES, agentServiceError } from "./errors.js";

export const DEFAULT_ARGUMENTS_MAX_BYTES = 64 * 1024;
export const DEFAULT_RESULT_MAX_BYTES = 1024 * 1024;

/** Process-local consumption store for approval replay protection. */
const defaultApprovalStore = createInMemoryApprovalStore();

export type ToolCallAuthorization = {
  service: AgentServiceDefinition;
  tool: AgentServiceToolDefinition;
  arguments: Record<string, unknown>;
  approval_required: boolean;
  approval_verified: boolean;
  billing_action: false;
  side_effect: boolean;
  network: true;
};

export type AuthorizeToolCallInput = {
  service: AgentServiceDefinition;
  toolName: string;
  arguments?: unknown;
  approvalArtifact?: unknown;
  approvalStore?: ApprovalConsumptionStore;
  now?: Date;
  argumentsMaxBytes?: number;
};

/**
 * Fail-closed authorization before any remote MCP callTool.
 * Registry allowlist, write-like names, policy, size, and human approval are checked here.
 */
export function authorizeToolCall(input: AuthorizeToolCallInput): ToolCallAuthorization {
  const tool = getServiceTool(input.service, input.toolName);
  if (!tool) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolUndeclared,
      `tool '${input.toolName}' is not declared in the agent service registry allowlist`
    );
  }

  if (looksWriteLikeToolName(tool.name) && tool.policy.action === "read_public_data") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolWriteLike,
      `tool '${tool.name}' looks write-like and is blocked under read_public_data`
    );
  }

  if (tool.policy.action === "side_effect" && tool.policy.approval !== "required") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolPolicy,
      `tool '${tool.name}' has an inconsistent side-effect policy`
    );
  }

  const args = normalizeArguments(input.arguments, input.argumentsMaxBytes);
  const sideEffect = tool.policy.action === "side_effect";
  const approvalRequired = tool.policy.approval === "required";

  let approvalVerified = false;
  if (approvalRequired) {
    verifyApprovalArtifact({
      serviceId: input.service.id,
      tool: tool.name,
      arguments: args,
      artifact: input.approvalArtifact,
      now: input.now,
      consumed: input.approvalStore ?? defaultApprovalStore
    });
    approvalVerified = true;
  } else if (input.approvalArtifact != null) {
    // Extra artifacts are ignored for approval=none tools (no side effect).
    approvalVerified = false;
  }

  if (tool.policy.action === "read_public_data" && tool.policy.approval !== "none") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolPolicy,
      `tool '${tool.name}' policy is inconsistent`
    );
  }

  return {
    service: input.service,
    tool,
    arguments: args,
    approval_required: approvalRequired,
    approval_verified: approvalVerified,
    billing_action: false,
    side_effect: sideEffect,
    network: true
  };
}

export function normalizeArguments(
  value: unknown,
  maxBytes = DEFAULT_ARGUMENTS_MAX_BYTES
): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > maxBytes) {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.argumentsTooLarge,
        `arguments exceed ${maxBytes} bytes`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw agentServiceError(
        AGENT_SERVICE_ISSUE_CODES.argumentsInvalid,
        "arguments must be valid JSON"
      );
    }
    return normalizeArguments(parsed, maxBytes);
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.argumentsInvalid,
      "arguments must be a JSON object"
    );
  }
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.argumentsTooLarge,
      `arguments exceed ${maxBytes} bytes`
    );
  }
  return value as Record<string, unknown>;
}

export function assertResultSize(value: unknown, maxBytes = DEFAULT_RESULT_MAX_BYTES): void {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? "null";
  } catch {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.resultTooLarge,
      "result could not be serialized within size limits"
    );
  }
  if (Buffer.byteLength(encoded, "utf8") > maxBytes) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.resultTooLarge,
      `result exceeds ${maxBytes} bytes`
    );
  }
}
