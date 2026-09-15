/**
 * Phase 1 executable boundary.
 * Prompt-only "do not spend" is not enough, and an env/array grant is not
 * approval. Denied commands cannot be unlocked in this phase.
 */

export const PHASE1_OBSERVE_COMMANDS = Object.freeze([
  "check",
  "plan",
  "doctor",
  "paths",
  "builds",
  "history",
  "inspect",
  "logs",
  "status",
  "measure",
  "vocabulary",
  "help"
]);

export const PHASE1_ALWAYS_DENIED = Object.freeze({
  build: "submits a durable Build and may start the Worker",
  pricing: "reads Provider pricing over the network",
  transcribe: "invokes a WhisperX Endpoint (local or hosted)",
  capture: "runs browser capture / may install a browser",
  studio: "starts Studio and can write supported source edits",
  cancel: "withdraws an active Build",
  activity: "attaches to live Worker capacity",
  get: "writes an export; Phase 1 has no realpath export grant",
  "_worker": "internal Worker process entry"
});

const RUNTIME_START = new Set(["up", "down", "init", "use", "unset"]);
const PROGRAM_MUTATE = new Set(["up", "down"]);
const AUTH_WRITE = new Set(["login", "logout"]);
const RESULT_MUTATE = new Set(["edit", "finish", "discard"]);
const PACKAGE_WRITE = new Set(["install"]);

export function parseCommand(argv) {
  const args = argv.filter((item) => item !== "--");
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    return { command: "help", action: undefined, flags: args.slice(1) };
  }
  if (args[0] === "--version" || args[0] === "-v") {
    return { command: "version", action: undefined, flags: [] };
  }
  const command = args[0];
  const action = typeof args[1] === "string" && !args[1].startsWith("-") ? args[1] : undefined;
  return { command, action, flags: args.slice(1) };
}

export function classifyHypitArgv(argv) {
  const parsed = parseCommand(argv);
  if (parsed.command === "help" || parsed.command === "version") {
    return { ...parsed, class: "observe", reason: "read-only launcher identity" };
  }
  if (parsed.command === "runtime") {
    if (parsed.action === "status" || parsed.action === "logs") {
      return { ...parsed, class: "observe", reason: "read Worker/program state without starting it" };
    }
    if (RUNTIME_START.has(parsed.action) || parsed.action === undefined) {
      return {
        ...parsed,
        class: "denied",
        reason: `runtime ${parsed.action ?? "(missing action)"} is not an observe command in Phase 1`
      };
    }
    return { ...parsed, class: "denied", reason: "unknown runtime action" };
  }
  if (parsed.command === "programs") {
    if (parsed.action === "status") {
      return { ...parsed, class: "observe", reason: "read Managed Program status" };
    }
    if (PROGRAM_MUTATE.has(parsed.action) || parsed.action === undefined) {
      return {
        ...parsed,
        class: "denied",
        reason: `programs ${parsed.action ?? "(missing action)"} starts or stops declared external programs`
      };
    }
    return { ...parsed, class: "denied", reason: "unknown programs action" };
  }
  if (parsed.command === "auth") {
    if (parsed.action === "status") {
      return { ...parsed, class: "observe", reason: "credential presence without printing secrets" };
    }
    if (AUTH_WRITE.has(parsed.action) || parsed.action === undefined) {
      return { ...parsed, class: "denied", reason: `auth ${parsed.action ?? "(missing action)"} writes or removes Endpoint credentials` };
    }
    return { ...parsed, class: "denied", reason: "unknown auth action" };
  }
  if (parsed.command === "packages") {
    if (parsed.action === "status") {
      return { ...parsed, class: "observe", reason: "read pinned upstream package status" };
    }
    if (PACKAGE_WRITE.has(parsed.action) || parsed.action === undefined) {
      return { ...parsed, class: "denied", reason: "packages install writes the Hypit machine home" };
    }
    return { ...parsed, class: "denied", reason: "unknown packages action" };
  }
  if (parsed.command === "result") {
    return {
      ...parsed,
      class: "denied",
      reason: RESULT_MUTATE.has(parsed.action)
        ? `result ${parsed.action} mutates a Build Result`
        : "unknown result action"
    };
  }
  if (Object.hasOwn(PHASE1_ALWAYS_DENIED, parsed.command)) {
    return {
      ...parsed,
      class: "denied",
      reason: PHASE1_ALWAYS_DENIED[parsed.command]
    };
  }
  if (PHASE1_OBSERVE_COMMANDS.includes(parsed.command)) {
    if (parsed.command === "status" && parsed.flags.includes("--watch")) {
      return { ...parsed, class: "denied", reason: "status --watch attaches to a live Worker" };
    }
    return { ...parsed, class: "observe", reason: "Phase 1 observe command" };
  }
  return { ...parsed, class: "denied", reason: `unknown command ${parsed.command}` };
}

export function assertAllowed(argv, grants = []) {
  const classification = classifyHypitArgv(argv);
  if (grants.length > 0) {
    const error = new Error(
      "Phase 1 ignores grant arrays and environment unlocks. Denied Hypit commands stay denied."
    );
    error.code = "HYPIT_GRANT_REJECTED";
    error.classification = classification;
    throw error;
  }
  if (classification.class === "observe") return classification;
  const error = new Error(
    `Hypit command refused (${classification.command}${classification.action ? ` ${classification.action}` : ""}): ${classification.reason}. Phase 1 has no grant override.`
  );
  error.code = "HYPIT_PERMISSION_DENIED";
  error.classification = classification;
  throw error;
}
