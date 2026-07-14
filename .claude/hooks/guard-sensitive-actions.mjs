let inputText = "";
for await (const chunk of process.stdin) inputText += chunk;
const input = inputText ? JSON.parse(inputText) : {};
if (input.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") {
  process.exit(0);
}

const commands = input.tool_input.command
  .split(/(?:&&|\|\||;|\n)/)
  .map((command) => command.trim())
  .filter(Boolean);

const destructive = commands.find(isDestructive);
if (destructive) {
  respond("deny", `Destructive command is blocked by the Tsugite project policy: ${destructive}`);
}

const approvalRequired = commands.find((command) => {
  if (/\b(?:\.\/)?bin\/pipeline\s+(?:gate|render|shitate-import)\b/.test(command)) return true;
  if (/\b(?:\.\/)?bin\/pipeline\s+finalize\b/.test(command) && /\s--apply(?:\s|$)/.test(command)) return true;
  if (/\b(?:\.\/)?bin\/pipeline\s+run\b/.test(command) && !/\s--dry-run(?:\s|$)/.test(command)) return true;
  return /\bgit\s+(?:commit|push)\b/.test(command) || /\bgh\s+pr\s+create\b/.test(command);
});
if (approvalRequired) {
  respond("ask", `Explicit user approval is required before this Tsugite action: ${approvalRequired}`);
}

function respond(permissionDecision, permissionDecisionReason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision,
      permissionDecisionReason
    }
  })}\n`);
  process.exit(0);
}

function isDestructive(command) {
  if (/\bgit\s+reset\s+--hard\b/.test(command)) return true;

  const gitCleanFlags = optionTokens(command.match(/\bgit\s+clean\s+((?:(?:-[a-z]+|--[a-z-]+)\s*)+)/i)?.[1]);
  if (hasShortFlag(gitCleanFlags, "f") && hasShortFlag(gitCleanFlags, "d")) return true;

  const rmFlags = optionTokens(command.match(/\brm\s+((?:(?:-[a-z]+|--[a-z-]+)\s*)+)/i)?.[1]);
  const isRecursive = hasShortFlag(rmFlags, "r") || rmFlags.includes("--recursive");
  const isForced = hasShortFlag(rmFlags, "f") || rmFlags.includes("--force");
  return isRecursive && isForced;
}

function optionTokens(value = "") {
  return value.trim().split(/\s+/).filter(Boolean);
}

function hasShortFlag(tokens, flag) {
  return tokens.some((token) => /^-[a-z]+$/i.test(token) && token.slice(1).toLowerCase().includes(flag));
}
