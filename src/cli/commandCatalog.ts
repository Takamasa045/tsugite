export type CommandSafety = "read-only" | "local-write" | "approval-gated";

export type CommandName =
  | "doctor"
  | "guides"
  | "story-guides"
  | "connections"
  | "presets"
  | "viewer-launcher"
  | "feedback"
  | "shitate-import"
  | "validate"
  | "finalize"
  | "plan"
  | "analyze"
  | "viewer"
  | "review"
  | "run"
  | "gate"
  | "render";

export type CommandOptionSpec = Readonly<{
  name: string;
  value?: string;
  summary: string;
}>;

export type CommandSpec = Readonly<{
  name: CommandName;
  summary: string;
  usage: string;
  requiresConfig: boolean;
  safety: CommandSafety;
  options: readonly CommandOptionSpec[];
}>;

function defineOption(name: string, summary: string, value?: string): CommandOptionSpec {
  return Object.freeze({ name, ...(value ? { value } : {}), summary });
}

const OPTIONS = {
  config: defineOption("--config", "Path to the project configuration.", "<project.yaml>"),
  catalog: defineOption("--catalog", "Prompt guide catalog identifier.", "<catalog-id>"),
  model: defineOption("--model", "Model identifier used to filter guidance or connections.", "<model-id>"),
  inputMode: defineOption("--input-mode", "Generation input mode used to resolve guidance.", "<mode>"),
  capability: defineOption("--capability", "Media capability used to filter connections.", "<capability>"),
  request: defineOption("--request", "Creative request used for story recommendations.", "<brief>"),
  duration: defineOption("--duration", "Target duration in seconds.", "<seconds>"),
  backend: defineOption("--backend", "Backend whose presentation presets are listed.", "<backend-id>"),
  projectsDir: defineOption("--projects-dir", "Directory scanned for Tsugite projects.", "<directory>"),
  port: defineOption("--port", "Local launcher port; use 0 to choose an available port.", "<port>"),
  open: defineOption("--open", "Open the generated local page in a browser."),
  key: defineOption("--key", "Stable feedback preference key.", "<key>"),
  category: defineOption("--category", "Feedback category.", "<category>"),
  signal: defineOption("--signal", "Preference signal: prefer, avoid, or keep.", "<signal>"),
  stage: defineOption("--stage", "Feedback lifecycle stage.", "<stage>"),
  summary: defineOption("--summary", "Short feedback summary.", "<text>"),
  runId: defineOption("--run-id", "Run identifier.", "<run-id>"),
  gate: defineOption("--gate", "Gate identifier.", "<gate-id>"),
  evidence: defineOption("--evidence", "Evidence supporting the feedback entry.", "<text>"),
  promotionKind: defineOption("--promotion-kind", "Reusable-rule promotion kind.", "<kind>"),
  target: defineOption("--target", "Promotion target path or identifier.", "<target>"),
  proposalSummary: defineOption("--proposal-summary", "Proposed reusable change.", "<text>"),
  verification: defineOption("--verification", "How the proposed change will be verified.", "<text>"),
  proposalWorkflow: defineOption("--proposal-workflow", "Automation workflow identifier.", "<workflow-id>"),
  proposalRunId: defineOption("--proposal-run-id", "Automation run identifier.", "<run-id>"),
  proposalSource: defineOption("--proposal-source", "Host that produced the proposal.", "<source>"),
  shitateRoot: defineOption("--shitate-root", "Root of the Shitate repository.", "<directory>"),
  character: defineOption("--character", "Shitate character identifier.", "<character-id>"),
  anchor: defineOption("--anchor", "Selected Shitate image anchor.", "<anchor>"),
  requestId: defineOption("--request-id", "Generation request identifier to update.", "<request-id>"),
  speakerId: defineOption("--speaker-id", "Speaker identifier for the imported character.", "<speaker-id>"),
  displayName: defineOption("--display-name", "Display name for the imported character.", "<name>"),
  side: defineOption("--side", "Character layout side: left or right.", "<side>"),
  accent: defineOption("--accent", "Character accent color.", "<color>"),
  stateDir: defineOption("--state-dir", "Alternate pipeline state directory.", "<directory>"),
  actor: defineOption("--actor", "Pipeline actor; gated actions require coordinator.", "<role>"),
  apply: defineOption("--apply", "Apply the inspected finalize deletion plan."),
  allowExternalAnalysis: defineOption(
    "--allow-external-analysis",
    "Allow configured external analysis adapters to run."
  ),
  output: defineOption("--output", "Alternate output directory.", "<directory>"),
  dryRun: defineOption("--dry-run", "Plan the run without executing adapters or writing state."),
  decision: defineOption("--decision", "Decision allowed by the selected gate.", "<decision>")
} as const satisfies Record<string, CommandOptionSpec>;

export const GLOBAL_OPTIONS: readonly CommandOptionSpec[] = Object.freeze([
  defineOption("--json", "Emit stable machine-readable JSON."),
  defineOption("--help", "Show help for the selected command.")
]);

function defineCommand(
  spec: Omit<CommandSpec, "options"> & { options: readonly CommandOptionSpec[] }
): CommandSpec {
  return Object.freeze({ ...spec, options: Object.freeze([...spec.options]) });
}

const COMMANDS: readonly CommandSpec[] = Object.freeze([
  defineCommand({
    name: "doctor",
    summary: "Inspect local runtime and optional project readiness.",
    usage: "node bin/pipeline doctor [--config <project.yaml>] [--json]",
    requiresConfig: false,
    safety: "read-only",
    options: [OPTIONS.config]
  }),
  defineCommand({
    name: "guides",
    summary: "List or resolve advisory generation prompt guidance.",
    usage: "node bin/pipeline guides [--catalog <catalog-id>] [--model <model-id> --input-mode <mode>] [--json]",
    requiresConfig: false,
    safety: "read-only",
    options: [OPTIONS.catalog, OPTIONS.model, OPTIONS.inputMode]
  }),
  defineCommand({
    name: "story-guides",
    summary: "List story frameworks or recommend them for a creative brief.",
    usage: "node bin/pipeline story-guides [--request <brief>] [--duration <seconds>] [--json]",
    requiresConfig: false,
    safety: "read-only",
    options: [OPTIONS.request, OPTIONS.duration]
  }),
  defineCommand({
    name: "connections",
    summary: "Inspect compatible generation connection profiles.",
    usage: "node bin/pipeline connections [--model <model-id>] [--capability <capability>] [--json]",
    requiresConfig: false,
    safety: "read-only",
    options: [OPTIONS.model, OPTIONS.capability]
  }),
  defineCommand({
    name: "presets",
    summary: "List presentation presets declared by a backend.",
    usage: "node bin/pipeline presets --backend <backend-id> [--json]",
    requiresConfig: false,
    safety: "read-only",
    options: [OPTIONS.backend]
  }),
  defineCommand({
    name: "viewer-launcher",
    summary: "Start the local multi-project workflow launcher.",
    usage: "node bin/pipeline viewer-launcher [--projects-dir <directory>] [--port <port>] [--open] [--json]",
    requiresConfig: false,
    safety: "local-write",
    options: [OPTIONS.projectsDir, OPTIONS.port, OPTIONS.open]
  }),
  defineCommand({
    name: "feedback",
    summary: "Append project-scoped preference or promotion feedback.",
    usage: "node bin/pipeline feedback --config <project.yaml> --key <key> --category <category> --signal <signal> --stage <stage> --summary <text> [options] [--json]",
    requiresConfig: true,
    safety: "local-write",
    options: [
      OPTIONS.config,
      OPTIONS.key,
      OPTIONS.category,
      OPTIONS.signal,
      OPTIONS.stage,
      OPTIONS.summary,
      OPTIONS.runId,
      OPTIONS.gate,
      OPTIONS.evidence,
      OPTIONS.promotionKind,
      OPTIONS.target,
      OPTIONS.proposalSummary,
      OPTIONS.verification,
      OPTIONS.proposalWorkflow,
      OPTIONS.proposalRunId,
      OPTIONS.proposalSource
    ]
  }),
  defineCommand({
    name: "shitate-import",
    summary: "Copy an approved Shitate character snapshot into a project.",
    usage: "node bin/pipeline shitate-import --config <project.yaml> --shitate-root <directory> --character <character-id> --run-id <run-id> [options] [--json]",
    requiresConfig: true,
    safety: "local-write",
    options: [
      OPTIONS.config,
      OPTIONS.shitateRoot,
      OPTIONS.character,
      OPTIONS.runId,
      OPTIONS.anchor,
      OPTIONS.requestId,
      OPTIONS.speakerId,
      OPTIONS.displayName,
      OPTIONS.side,
      OPTIONS.accent
    ]
  }),
  defineCommand({
    name: "validate",
    summary: "Validate a project, manifest, adapters, and safety constraints.",
    usage: "node bin/pipeline validate --config <project.yaml> [--json]",
    requiresConfig: true,
    safety: "read-only",
    options: [OPTIONS.config]
  }),
  defineCommand({
    name: "finalize",
    summary: "Preview or apply completion-only cleanup for superseded media.",
    usage: "node bin/pipeline finalize --config <project.yaml> [--state-dir <directory>] [--apply --actor coordinator] [--json]",
    requiresConfig: true,
    safety: "approval-gated",
    options: [OPTIONS.config, OPTIONS.stateDir, OPTIONS.actor, OPTIONS.apply]
  }),
  defineCommand({
    name: "plan",
    summary: "Create a deterministic execution plan without running adapters.",
    usage: "node bin/pipeline plan --config <project.yaml> [--json]",
    requiresConfig: true,
    safety: "read-only",
    options: [OPTIONS.config]
  }),
  defineCommand({
    name: "analyze",
    summary: "Run coordinator-controlled media analysis and write its artifacts.",
    usage: "node bin/pipeline analyze --config <project.yaml> --actor coordinator [--state-dir <directory>] [--allow-external-analysis] [--json]",
    requiresConfig: true,
    safety: "approval-gated",
    options: [OPTIONS.config, OPTIONS.actor, OPTIONS.stateDir, OPTIONS.allowExternalAnalysis]
  }),
  defineCommand({
    name: "viewer",
    summary: "Write a local workflow snapshot from the current project state.",
    usage: "node bin/pipeline viewer --config <project.yaml> [--output <directory>] [--state-dir <directory>] [--open] [--json]",
    requiresConfig: true,
    safety: "local-write",
    options: [OPTIONS.config, OPTIONS.output, OPTIONS.stateDir, OPTIONS.open]
  }),
  defineCommand({
    name: "review",
    summary: "Write the local Gate 1 creative review artifacts.",
    usage: "node bin/pipeline review --config <project.yaml> [--output <directory>] [--state-dir <directory>] [--open] [--json]",
    requiresConfig: true,
    safety: "local-write",
    options: [OPTIONS.config, OPTIONS.output, OPTIONS.stateDir, OPTIONS.open]
  }),
  defineCommand({
    name: "run",
    summary: "Dry-run a plan or execute an approved Gate 1 run as coordinator.",
    usage: "node bin/pipeline run --config <project.yaml> [--dry-run | --actor coordinator] [--state-dir <directory>] [--json]",
    requiresConfig: true,
    safety: "approval-gated",
    options: [OPTIONS.config, OPTIONS.dryRun, OPTIONS.actor, OPTIONS.stateDir]
  }),
  defineCommand({
    name: "gate",
    summary: "Record a human approval, revision, or abort decision.",
    usage: "node bin/pipeline gate --config <project.yaml> --actor coordinator --gate <gate-id> --decision <decision> [--state-dir <directory>] [--json]",
    requiresConfig: true,
    safety: "approval-gated",
    options: [OPTIONS.config, OPTIONS.actor, OPTIONS.gate, OPTIONS.decision, OPTIONS.stateDir]
  }),
  defineCommand({
    name: "render",
    summary: "Render an assembled run after Gate 2 approval.",
    usage: "node bin/pipeline render --config <project.yaml> --actor coordinator [--state-dir <directory>] [--json]",
    requiresConfig: true,
    safety: "approval-gated",
    options: [OPTIONS.config, OPTIONS.actor, OPTIONS.stateDir]
  })
]);

const commandByName: ReadonlyMap<string, CommandSpec> = new Map(
  COMMANDS.map((command) => [command.name, command])
);
const globalOptionNames = new Set(GLOBAL_OPTIONS.map(({ name }) => name));

export function listCommandHelp(): readonly CommandSpec[] {
  return COMMANDS;
}

export function getCommandHelp(name: string): CommandSpec | undefined {
  return commandByName.get(name);
}

export function isKnownCommand(name: string): name is CommandName {
  return commandByName.has(name);
}

export function isCommandOptionAllowed(command: string, option: string): boolean {
  const spec = getCommandHelp(command);
  if (!spec) return true;
  return globalOptionNames.has(option) || spec.options.some(({ name }) => name === option);
}

export function commandRequiresConfig(command: string): boolean {
  return getCommandHelp(command)?.requiresConfig ?? false;
}

export function suggestCommands(input: string, limit = 3): readonly CommandName[] {
  const query = input.trim().toLowerCase();
  const resultLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (!query || resultLimit === 0) return [];

  const maximumDistance = Math.max(2, Math.floor(query.length / 3));
  return COMMANDS
    .map(({ name }, index) => ({
      name,
      index,
      distance: levenshteinDistance(query, name),
      prefix: name.startsWith(query)
    }))
    .filter(({ distance, prefix }) => prefix || distance <= maximumDistance)
    .sort((left, right) => {
      if (left.prefix !== right.prefix) return left.prefix ? -1 : 1;
      if (left.distance !== right.distance) return left.distance - right.distance;
      return left.index - right.index;
    })
    .slice(0, resultLimit)
    .map(({ name }) => name);
}

function levenshteinDistance(left: string, right: string): number {
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
    }
    previous = current;
  }

  return previous[right.length];
}
