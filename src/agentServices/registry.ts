import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { validateRegistryEndpoint, type ValidatedEndpoint } from "./endpoint.js";
import { AGENT_SERVICE_ISSUE_CODES, agentServiceError } from "./errors.js";

export const AGENT_SERVICE_REGISTRY_SCHEMA_VERSION = 1 as const;

const safeId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*$/, "id must match safe format");

const safeToolName = z
  .string()
  .regex(/^[a-zA-Z][a-zA-Z0-9._-]{0,127}$/, "tool name must match safe format");

const capability = z
  .string()
  .regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/, "capability must be dotted lowercase");

/**
 * Schema may express future side_effect / approval=required tools.
 * The read-only MVP runtime always refuses those before network.
 */
const toolPolicySchema = z.object({
  action: z.enum(["read_public_data", "side_effect"]),
  approval: z.enum(["none", "required"])
}).superRefine((policy, context) => {
  if (policy.action === "read_public_data" && policy.approval !== "none") {
    context.addIssue({
      code: "custom",
      message: "read_public_data tools must use approval=none",
      path: ["approval"]
    });
  }
  if (policy.action === "side_effect" && policy.approval !== "required") {
    context.addIssue({
      code: "custom",
      message: "side_effect tools must use approval=required",
      path: ["approval"]
    });
  }
});

const toolDefinitionSchema = z.object({
  name: safeToolName,
  policy: toolPolicySchema
});

const serviceDefinitionSchema = z.object({
  id: safeId,
  display_name: z.string().min(1),
  type: z.literal("mcp-remote"),
  transport: z.literal("streamable-http"),
  endpoint: z.string().min(1),
  auth_kind: z.literal("none"),
  capabilities: z.array(capability).min(1),
  tools: z.array(toolDefinitionSchema).min(1)
}).superRefine((service, context) => {
  try {
    validateRegistryEndpoint(service.endpoint);
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid endpoint";
    context.addIssue({
      code: "custom",
      message,
      path: ["endpoint"]
    });
  }

  const toolNames = new Set<string>();
  for (const [index, tool] of service.tools.entries()) {
    if (toolNames.has(tool.name)) {
      context.addIssue({
        code: "custom",
        message: `duplicate tool name '${tool.name}'`,
        path: ["tools", index, "name"]
      });
    }
    toolNames.add(tool.name);

    if (looksWriteLikeToolName(tool.name) && tool.policy.action === "read_public_data") {
      context.addIssue({
        code: "custom",
        message: `write-like tool name '${tool.name}' cannot use read_public_data`,
        path: ["tools", index, "policy", "action"]
      });
    }
  }
});

const registrySchema = z.object({
  schema_version: z.literal(AGENT_SERVICE_REGISTRY_SCHEMA_VERSION),
  services: z.array(serviceDefinitionSchema).min(1)
}).superRefine((registry, context) => {
  const seen = new Set<string>();
  for (const [index, service] of registry.services.entries()) {
    if (seen.has(service.id)) {
      context.addIssue({
        code: "custom",
        message: `duplicate service id '${service.id}'`,
        path: ["services", index, "id"]
      });
    }
    seen.add(service.id);
  }
});

export type AgentServiceRegistry = z.infer<typeof registrySchema>;
export type AgentServiceDefinition = z.infer<typeof serviceDefinitionSchema>;
export type AgentServiceToolDefinition = z.infer<typeof toolDefinitionSchema>;
export type AgentServiceToolPolicy = z.infer<typeof toolPolicySchema>;

export type AgentServiceSummary = {
  id: string;
  display_name: string;
  type: "mcp-remote";
  transport: "streamable-http";
  auth_kind: "none";
  capabilities: string[];
  tools: Array<{
    name: string;
    policy: AgentServiceToolPolicy;
  }>;
  endpoint_host: string;
  endpoint_canonical: string;
  /** Never a purchase/payment action via agent services. */
  billing_action: false;
  /**
   * Public MCP queries may consume provider quota/usage even without billing_action.
   */
  provider_usage_possible: true;
  side_effect: boolean;
  /**
   * True when any declared tool uses approval=required in schema.
   * The MVP runtime never unlocks those tools from this CLI.
   */
  schema_requires_human_gate: boolean;
  /** True when every declared tool is MVP-executable (read_public_data / approval=none). */
  mvp_executable: boolean;
};

const defaultRegistryPath = fileURLToPath(
  new URL("../../agent-services/registry.yaml", import.meta.url)
);

export function getDefaultAgentServiceRegistryPath(): string {
  return defaultRegistryPath;
}

/**
 * Load and validate an agent service registry.
 * Production CLI always uses the bundled path. Path injection is for
 * programmatic tests only — never from CLI env/flags.
 */
export async function loadAgentServiceRegistry(
  registryPath = defaultRegistryPath
): Promise<AgentServiceRegistry> {
  let raw: unknown;
  try {
    raw = await readYamlFile(registryPath);
  } catch (error) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.registryInvalid,
      error instanceof Error ? error.message : "failed to read agent service registry"
    );
  }

  const parsed = registrySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path?.length ? first.path.join(".") : undefined;
    const message = first?.message ?? "agent service registry is invalid";
    if (message.includes("duplicate service id")) {
      throw agentServiceError(AGENT_SERVICE_ISSUE_CODES.registryDuplicate, message, path);
    }
    throw agentServiceError(AGENT_SERVICE_ISSUE_CODES.registryInvalid, message, path);
  }
  return parsed.data;
}

export async function listAgentServices(
  registryPath = defaultRegistryPath
): Promise<AgentServiceSummary[]> {
  const registry = await loadAgentServiceRegistry(registryPath);
  return registry.services.map(summarizeService);
}

export async function resolveAgentService(
  serviceId: string,
  registryPath = defaultRegistryPath
): Promise<AgentServiceDefinition & { endpoint_validated: ValidatedEndpoint }> {
  const registry = await loadAgentServiceRegistry(registryPath);
  const service = registry.services.find((item) => item.id === serviceId);
  if (!service) {
    throw agentServiceError(
      AGENT_SERVICE_ISSUE_CODES.serviceNotFound,
      `agent service '${serviceId}' was not found`
    );
  }
  return {
    ...service,
    endpoint_validated: validateRegistryEndpoint(service.endpoint)
  };
}

export function getServiceTool(
  service: AgentServiceDefinition,
  toolName: string
): AgentServiceToolDefinition | undefined {
  return service.tools.find((tool) => tool.name === toolName);
}

export function summarizeService(service: AgentServiceDefinition): AgentServiceSummary {
  const endpoint = validateRegistryEndpoint(service.endpoint);
  const schemaRequiresHumanGate = service.tools.some(
    (tool) => tool.policy.approval === "required" || tool.policy.action === "side_effect"
  );
  const sideEffect = service.tools.some((tool) => tool.policy.action === "side_effect");
  const mvpExecutable = service.tools.every(
    (tool) => tool.policy.action === "read_public_data" && tool.policy.approval === "none"
      && !looksWriteLikeToolName(tool.name)
  );
  return {
    id: service.id,
    display_name: service.display_name,
    type: service.type,
    transport: service.transport,
    auth_kind: service.auth_kind,
    capabilities: [...service.capabilities],
    tools: service.tools.map((tool) => ({
      name: tool.name,
      policy: { ...tool.policy }
    })),
    endpoint_host: endpoint.hostname,
    endpoint_canonical: endpoint.canonical,
    billing_action: false,
    provider_usage_possible: true,
    side_effect: sideEffect,
    schema_requires_human_gate: schemaRequiresHumanGate,
    mvp_executable: mvpExecutable
  };
}

/**
 * Names that look like mutating / side-effect operations (defense-in-depth).
 * Action field remains authoritative; this blocks accidental read_public_data labels.
 */
export function looksWriteLikeToolName(name: string): boolean {
  const normalized = name.toLowerCase().replace(/[._-]+/g, "_");
  const segments = normalized.split("_").filter(Boolean);
  const blocked = new Set([
    "write",
    "create",
    "update",
    "delete",
    "remove",
    "send",
    "submit",
    "post",
    "push",
    "publish",
    "upload",
    "purchase",
    "pay",
    "book",
    "reserve",
    "mutate",
    "insert",
    "patch",
    "destroy",
    "order",
    "checkout",
    "execute",
    "invoke_write",
    "edit",
    "drop",
    "grant",
    "revoke",
    "transfer",
    "approve",
    "commit",
    "merge",
    "cancel",
    "refund",
    "charge",
    "debit",
    "credit",
    "deploy",
    "provision",
    "invite",
    "ban",
    "suspend",
    "enable",
    "disable",
    "set",
    "put",
    "replace",
    "overwrite",
    "attach",
    "detach",
    "assign",
    "unassign"
  ]);
  return segments.some((segment) => blocked.has(segment));
}

export { registrySchema, serviceDefinitionSchema, toolDefinitionSchema, toolPolicySchema };
