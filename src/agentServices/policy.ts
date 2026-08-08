import type { AgentServiceDefinition, AgentServiceToolDefinition } from "./registry.js";
import { getServiceTool, looksWriteLikeToolName } from "./registry.js";
import { AGENT_SERVICE_ISSUE_CODES, agentServiceError } from "./errors.js";

export const DEFAULT_ARGUMENTS_MAX_BYTES = 64 * 1024;
export const DEFAULT_RESULT_MAX_BYTES = 1024 * 1024;

export type ToolCallAuthorization = {
  service: AgentServiceDefinition;
  tool: AgentServiceToolDefinition;
  arguments: Record<string, unknown>;
  /** Always false: Agent Services never perform purchase/payment actions. */
  billing_action: false;
  /**
   * Public MCP queries may still consume provider quota/usage even when
   * billing_action is false.
   */
  provider_usage_possible: true;
  side_effect: false;
  human_gate: "not_required";
};

export type AuthorizeToolCallInput = {
  service: AgentServiceDefinition;
  toolName: string;
  arguments?: unknown;
  argumentsMaxBytes?: number;
};

/**
 * Fail-closed authorization before any remote MCP connect/callTool.
 *
 * Read-only MVP: only `read_public_data` + `approval=none` tools may proceed.
 * Schema may still describe `side_effect` / `approval=required` for future
 * expression, but this runtime always rejects them before network. No approval
 * artifact, flag, or env var can unlock side effects from the agent CLI.
 */
export function authorizeToolCall(input: AuthorizeToolCallInput): ToolCallAuthorization {
  const tool = getServiceTool(input.service, input.toolName);
  if (!tool) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolUndeclared,
      `tool '${input.toolName}' is not declared in the agent service registry allowlist`
    );
  }

  // Action field is authoritative. side_effect is never executable here.
  if (tool.policy.action === "side_effect") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.sideEffectBlocked,
      `tool '${tool.name}' is a side_effect action; the agent-service MVP stops at the human gate and never executes it`
    );
  }

  // Defense-in-depth: approval=required also cannot be satisfied by artifacts.
  if (tool.policy.approval === "required") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.humanGateRequired,
      `tool '${tool.name}' requires a human gate outside this agent CLI; no approval artifact can unlock it`
    );
  }

  if (tool.policy.action !== "read_public_data" || tool.policy.approval !== "none") {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolPolicy,
      `tool '${tool.name}' policy is not executable in the read-only agent-service MVP`
    );
  }

  // Defense-in-depth after action: write-like names cannot run as read_public_data.
  if (looksWriteLikeToolName(tool.name)) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.toolWriteLike,
      `tool '${tool.name}' looks write-like and is blocked in the read-only agent-service MVP`
    );
  }

  const args = normalizeArguments(input.arguments, input.argumentsMaxBytes);

  return {
    service: input.service,
    tool,
    arguments: args,
    billing_action: false,
    provider_usage_possible: true,
    side_effect: false,
    human_gate: "not_required"
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
