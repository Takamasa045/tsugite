import { PipelineError, type Issue } from "../types.js";

export const AGENT_SERVICE_ISSUE_CODES = {
  registryInvalid: "agent_service.registry_invalid",
  registryDuplicate: "agent_service.duplicate_id",
  serviceNotFound: "agent_service.not_found",
  endpointInvalid: "agent_service.endpoint_invalid",
  endpointForbidden: "agent_service.endpoint_forbidden",
  endpointRedirect: "agent_service.endpoint_redirect_blocked",
  endpointDnsPrivate: "agent_service.endpoint_dns_private",
  toolUndeclared: "agent_service.tool_undeclared",
  toolWriteLike: "agent_service.tool_write_like_blocked",
  toolPolicy: "agent_service.tool_policy_blocked",
  sideEffectBlocked: "agent_service.side_effect_blocked",
  humanGateRequired: "agent_service.human_gate_required",
  argumentsInvalid: "agent_service.arguments_invalid",
  argumentsTooLarge: "agent_service.arguments_too_large",
  resultTooLarge: "agent_service.result_too_large",
  timeout: "agent_service.timeout",
  network: "agent_service.network",
  remote: "agent_service.remote_error",
  closed: "agent_service.client_closed"
} as const;

export type AgentServiceIssueCode =
  (typeof AGENT_SERVICE_ISSUE_CODES)[keyof typeof AGENT_SERVICE_ISSUE_CODES];

const SENSITIVE_PATTERN =
  /(?:api[_-]?key|authorization|bearer\s+[a-z0-9._-]+|password|secret|token\s*[:=]\s*\S+|https?:\/\/[^\s]+|\/Users\/[^\s]+|\/home\/[^\s]+|at\s+\S+\s+\([^)]+:\d+:\d+\))/gi;

export function agentServiceIssue(
  code: AgentServiceIssueCode | string,
  message: string,
  path?: string
): Issue {
  return {
    code,
    message: redactSensitive(message),
    ...(path ? { path } : {})
  };
}

export function agentServiceError(
  code: AgentServiceIssueCode | string,
  message: string,
  path?: string
): PipelineError {
  return new PipelineError(agentServiceIssue(code, message, path));
}

export function redactSensitive(text: string): string {
  return text.replace(SENSITIVE_PATTERN, "[redacted]");
}

export function normalizeRemoteError(error: unknown): Issue {
  if (error instanceof PipelineError) {
    return error.issues[0] ?? agentServiceIssue(AGENT_SERVICE_ISSUE_CODES.remote, "remote error");
  }

  const raw = error instanceof Error ? error.message : String(error);
  const lower = raw.toLowerCase();
  if (
    lower.includes("abort")
    || lower.includes("timeout")
    || lower.includes("timed out")
    || (error instanceof Error && error.name === "AbortError")
  ) {
    return agentServiceIssue(AGENT_SERVICE_ISSUE_CODES.timeout, "remote request timed out");
  }
  if (
    lower.includes("fetch failed")
    || lower.includes("network")
    || lower.includes("econnrefused")
    || lower.includes("enotfound")
    || lower.includes("econnreset")
  ) {
    return agentServiceIssue(AGENT_SERVICE_ISSUE_CODES.network, "remote network request failed");
  }
  return agentServiceIssue(AGENT_SERVICE_ISSUE_CODES.remote, "remote MCP request failed");
}
