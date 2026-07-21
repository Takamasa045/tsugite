import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import { commandExists as platformCommandExists } from "../platform/process.js";

const safeId = z.string().regex(/^[a-z0-9][a-z0-9._-]*$/);
const capability = z.string().regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/);

const setupCheckSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("command"), command: z.string().min(1) }),
  z.object({
    type: z.literal("environment"),
    variable: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
    direct_route_command: z.boolean().default(false)
  }),
  z.object({ type: z.literal("manual"), detail: z.string().min(1) })
]);

const connectionDefinitionSchema = z.object({
  id: safeId,
  aliases: z.array(safeId).default([]),
  display_name: z.string().min(1),
  provider: safeId,
  transport: z.enum(["cli", "mcp", "api", "local", "manual"]),
  auth_kind: z.enum(["subscription", "api-key", "local", "none"]),
  implementation_status: z.enum(["integrated", "available-to-add", "manual-import"]),
  adapter: safeId.optional(),
  execution_mode: z.enum(["pipeline-adapter", "agent-handoff"]).optional(),
  capabilities: z.array(capability).min(1),
  automated_capabilities: z.array(capability).default([]),
  model_policy: z.enum(["catalog", "runtime"]).default("catalog"),
  model_families: z.array(safeId).default([]),
  route_note: z.string().min(1),
  setup_checks: z.array(setupCheckSchema).default([])
}).superRefine((connection, context) => {
  if (connection.implementation_status === "integrated" && !connection.adapter) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "integrated connections must declare an adapter",
      path: ["adapter"]
    });
  }
  if (connection.model_policy === "catalog" && connection.model_families.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "catalog model policy requires at least one model family",
      path: ["model_families"]
    });
  }
  for (const [index, item] of connection.automated_capabilities.entries()) {
    if (!connection.capabilities.includes(item)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "automated capabilities must also be declared as service capabilities",
        path: ["automated_capabilities", index]
      });
    }
  }
  for (const [index, check] of connection.setup_checks.entries()) {
    if (check.type === "environment" && check.direct_route_command && !check.variable.endsWith("_COMMAND")) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "direct route commands are limited to *_COMMAND environment variables",
        path: ["setup_checks", index, "direct_route_command"]
      });
    }
  }
  if (
    connection.implementation_status === "integrated"
    && (connection.auth_kind === "subscription" || connection.auth_kind === "api-key")
    && !connection.setup_checks.some((check) => check.type === "environment" || check.type === "manual")
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "integrated authenticated connections must declare an environment or manual authentication check",
      path: ["setup_checks"]
    });
  }
});

const catalogSchema = z.object({
  schema_version: z.literal(1),
  selection_prompt: z.object({
    id: safeId,
    question: z.string().min(1),
    required_when: z.literal("connection-unspecified"),
    instruction: z.string().min(1),
    no_subscription_message: z.string().min(1),
    no_subscription_options: z.array(safeId).min(1)
  }),
  connections: z.array(connectionDefinitionSchema).min(1)
}).superRefine((catalog, context) => {
  const seen = new Set<string>();
  for (const [index, connection] of catalog.connections.entries()) {
    for (const [nameIndex, name] of [connection.id, ...connection.aliases].entries()) {
      const normalizedName = normalizeConnectionName(name);
      if (seen.has(normalizedName)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate normalized connection id or alias '${name}'`,
          path: ["connections", index, nameIndex === 0 ? "id" : "aliases"]
        });
      }
      seen.add(normalizedName);
    }
  }
});

export type ConnectionCatalog = z.infer<typeof catalogSchema>;
export type ConnectionDefinition = z.infer<typeof connectionDefinitionSchema>;
export type ConnectionCapability = z.infer<typeof capability>;
export type ConnectionSetupStatus = "ready" | "needs-verification" | "needs-setup" | "not-integrated";
export type ConnectionSetupCheck = {
  type: "command" | "environment" | "manual";
  status: "ready" | "missing" | "unverified";
  name: string;
  detail?: string;
};
export type ConnectionOption = Omit<ConnectionDefinition, "setup_checks"> & {
  automation_status: "integrated" | "available-to-add";
  setup: {
    status: ConnectionSetupStatus;
    checks: ConnectionSetupCheck[];
  };
};

export type ConnectionListOptions = {
  catalogPath?: string;
  model?: string;
  capability?: string;
  environment?: NodeJS.ProcessEnv;
  commandExists?: (command: string) => Promise<boolean>;
};

export type GenerationConnectionResolution = {
  id: string;
  adapter: string;
  transport: ConnectionDefinition["transport"];
  provider: string;
  route_note: string;
  auth_kind: ConnectionDefinition["auth_kind"];
  contract_digest: string;
  setup_status: ConnectionSetupStatus;
  execution_mode: "pipeline-adapter" | "agent-handoff";
};

export type GenerationConnectionRequirements = {
  models?: string[];
  capabilities?: string[];
};

const defaultCatalogPath = fileURLToPath(new URL("../../connections/catalog.yaml", import.meta.url));

export async function loadConnectionCatalog(catalogPath = defaultCatalogPath): Promise<ConnectionCatalog> {
  return catalogSchema.parse(await readYamlFile(catalogPath));
}

export async function listConnectionOptions(options: ConnectionListOptions = {}): Promise<ConnectionOption[]> {
  const catalog = await loadConnectionCatalog(options.catalogPath);
  const commandExists = options.commandExists ?? ((command) => platformCommandExists(command, options.environment));
  const matches = catalog.connections.filter((connection) =>
    (!options.capability || connection.capabilities.includes(options.capability))
    && (!options.model || supportsModel(connection, options.model))
  );

  return Promise.all(matches.map(async (connection) => ({
    ...omitSetupChecks(connection),
    automation_status: options.capability && connection.automated_capabilities.includes(options.capability)
      ? "integrated" as const
      : options.capability
        ? "available-to-add" as const
        : connection.automated_capabilities.length > 0
          ? "integrated" as const
          : "available-to-add" as const,
    setup: await inspectConnectionSetup(connection, {
      environment: options.environment ?? process.env,
      commandExists
    })
  })));
}

export async function resolveGenerationConnection(
  connectionId: string,
  catalogPath?: string,
  requirements: GenerationConnectionRequirements = {}
): Promise<GenerationConnectionResolution | undefined> {
  const catalog = await loadConnectionCatalog(catalogPath);
  const normalizedId = normalizeConnectionName(connectionId);
  const connection = catalog.connections.find((item) =>
    [item.id, ...item.aliases].some((name) => normalizeConnectionName(name) === normalizedId)
  );
  if (!connection?.adapter || connection.implementation_status !== "integrated") return undefined;
  if (connection.model_policy !== "runtime" && requirements.models?.some((model) => !supportsModel(connection, model))) return undefined;
  if (requirements.capabilities?.some((item) => !connection.automated_capabilities.includes(item))) {
    return undefined;
  }
  return resolveIntegratedConnection(connection);
}

export async function resolveConnectionByAdapter(
  adapterName: string,
  requirements: GenerationConnectionRequirements = {},
  catalogPath?: string
): Promise<GenerationConnectionResolution | undefined> {
  const candidates = await resolveConnectionsByAdapter(adapterName, requirements, catalogPath);
  if (candidates.length !== 1) return undefined;
  return candidates[0];
}

export async function resolveConnectionsByAdapter(
  adapterName: string,
  requirements: GenerationConnectionRequirements = {},
  catalogPath?: string
): Promise<GenerationConnectionResolution[]> {
  const catalog = await loadConnectionCatalog(catalogPath);
  const candidates = catalog.connections.filter((connection) =>
    connection.adapter === adapterName
    && connection.implementation_status === "integrated"
    && (connection.model_policy === "runtime" || !requirements.models?.some((model) => !supportsModel(connection, model)))
    && !requirements.capabilities?.some((item) => !connection.automated_capabilities.includes(item))
  );
  return Promise.all(candidates.map((connection) => resolveIntegratedConnection(connection)));
}

export async function isConnectionAdapterCompatible(
  connectionId: string,
  adapterName: string,
  catalogPath?: string
): Promise<boolean> {
  const resolved = await resolveGenerationConnection(connectionId, catalogPath);
  return resolved?.adapter === adapterName;
}

export async function connectionSelectionPrompt(options: ConnectionListOptions = {}) {
  const catalog = await loadConnectionCatalog(options.catalogPath);
  const candidates = await listConnectionOptions(options);
  return {
    ...catalog.selection_prompt,
    candidates: candidates.map((candidate) => ({
      id: candidate.id,
      display_name: candidate.display_name,
      provider: candidate.provider,
      transport: candidate.transport,
      auth_kind: candidate.auth_kind,
      implementation_status: candidate.implementation_status,
      automation_status: candidate.automation_status,
      setup_status: candidate.setup.status,
      execution_mode: connectionExecutionMode(candidate),
      route_note: candidate.route_note
    }))
  };
}

async function inspectConnectionSetup(
  connection: ConnectionDefinition,
  options: {
    environment: NodeJS.ProcessEnv;
    commandExists: (command: string) => Promise<boolean>;
  }
): Promise<ConnectionOption["setup"]> {
  const checks: ConnectionSetupCheck[] = [];
  for (const check of connection.setup_checks) {
    if (check.type === "command") {
      const exists = await options.commandExists(check.command);
      checks.push({ type: check.type, name: check.command, status: exists ? "ready" : "missing" });
      continue;
    }
    if (check.type === "environment") {
      const value = options.environment[check.variable];
      const configured = typeof value === "string" && value.trim().length > 0;
      const directExecutable = check.direct_route_command && configured
        ? parseDirectRouteCommand(value)
        : undefined;
      const directExecutableReady = directExecutable
        ? await options.commandExists(directExecutable)
        : false;
      const ready = check.direct_route_command
        ? Boolean(directExecutable && directExecutableReady)
        : configured;
      checks.push({
        type: check.type,
        name: check.variable,
        status: ready ? "ready" : "missing",
        ...(check.direct_route_command && !ready
          ? { detail: "must be a JSON array containing exactly one executable wrapper command" }
          : {})
      });
      continue;
    }
    checks.push({ type: check.type, name: "manual-verification", status: "unverified", detail: check.detail });
  }

  if (connection.implementation_status !== "integrated") return { status: "not-integrated", checks };
  if (checks.some((check) => check.status === "missing")) return { status: "needs-setup", checks };
  if (checks.some((check) => check.status === "unverified")) return { status: "needs-verification", checks };
  return { status: "ready", checks };
}

async function resolveIntegratedConnection(
  connection: ConnectionDefinition
): Promise<GenerationConnectionResolution> {
  const setup = await inspectConnectionSetup(connection, {
    environment: process.env,
    commandExists: (command) => platformCommandExists(command, process.env)
  });
  return {
    id: connection.id,
    adapter: connection.adapter!,
    transport: connection.transport,
    provider: connection.provider,
    route_note: connection.route_note,
    auth_kind: connection.auth_kind,
    contract_digest: connectionContractDigest(connection, process.env),
    setup_status: setup.status,
    execution_mode: connectionExecutionMode(connection)
  };
}

export function connectionExecutionMode(
  connection: Pick<ConnectionDefinition, "transport" | "execution_mode">
): "pipeline-adapter" | "agent-handoff" {
  return connection.execution_mode ?? (connection.transport === "cli" ? "pipeline-adapter" : "agent-handoff");
}

function connectionContractDigest(
  connection: ConnectionDefinition,
  environment: NodeJS.ProcessEnv
): string {
  const pinnedEnvironmentIdentities = connection.setup_checks.flatMap((check) => {
    if (check.type !== "environment" || !check.direct_route_command) return [];
    const value = environment[check.variable]?.trim() ?? "";
    const executable = parseDirectRouteCommand(value) ?? "invalid-direct-route-command";
    return [{
      variable: check.variable,
      executable_sha256: createHash("sha256").update(executable).digest("hex")
    }];
  });
  return createHash("sha256").update(JSON.stringify({
    connection,
    pinned_environment_identities: pinnedEnvironmentIdentities
  })).digest("hex");
}

function parseDirectRouteCommand(value: string): string | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !Array.isArray(parsed)
      || parsed.length !== 1
      || typeof parsed[0] !== "string"
      || parsed[0].length === 0
    ) return undefined;
    return parsed[0];
  } catch {
    return undefined;
  }
}

function supportsModel(connection: ConnectionDefinition, model: string): boolean {
  const normalizedModel = normalizeModel(model);
  return connection.model_families.some((family) => {
    const normalizedFamily = normalizeModel(family);
    const tokens = model.toLocaleLowerCase("en-US").split(/[^a-z0-9]+/).filter(Boolean);
    const familyTokens = family.toLocaleLowerCase("en-US").split(/[^a-z0-9]+/).filter(Boolean);
    if (connection.model_policy === "runtime") {
      return familyTokens.length > 0 && familyTokens.every((token, offset) => tokens[offset] === token);
    }
    const delimitedVersionMatch = familyTokens.length > 0 && (() => {
      if (!familyTokens.every((token, offset) => tokens[offset] === token)) return false;
      const suffix = tokens.slice(familyTokens.length);
      if (suffix.length === 0) return true;
      const versionToken = /^(?:v|version|o)?\d+$/;
      const qualifier = /^(?:pro|standard|fast|mini|lite|turbo|plus|max|preview)$/;
      return versionToken.test(suffix[0]!)
        && suffix.slice(1).every((token) => versionToken.test(token) || qualifier.test(token));
    })();
    const numericVersionMatch = normalizedModel.startsWith(normalizedFamily)
      && /^\d+$/.test(normalizedModel.slice(normalizedFamily.length));
    return normalizedModel === normalizedFamily || numericVersionMatch || delimitedVersionMatch;
  });
}

function normalizeModel(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function normalizeConnectionName(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(/[^a-z0-9]+/g, "");
}

function omitSetupChecks(connection: ConnectionDefinition): Omit<ConnectionDefinition, "setup_checks"> {
  const { setup_checks: _checks, ...publicConnection } = connection;
  return publicConnection;
}
