#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { applyDialogueDraft, buildDialogueDraftRequest, generateDialogueDraft } from "./dialogueDraft.mjs";

const [command, first, second, flag] = process.argv.slice(2);
try {
  if (command === "generate" && first && second && (!flag || flag === "--submit")) {
    const brief = JSON.parse(await readFile(first, "utf8"));
    buildDialogueDraftRequest(brief);
    if (flag !== "--submit") {
      process.stdout.write("Preview only. The brief is valid; add --submit to send one paid Gemini API request.\n");
    } else {
      const draft = await generateDialogueDraft(brief, second);
      process.stdout.write(`Draft saved: ${second} (${draft.turns.length} turns). Review it before apply.\n`);
    }
  } else if (command === "apply" && first && second && !flag) {
    const result = await applyDialogueDraft(first, second);
    process.stdout.write(`Applied ${result.turns} turns to ${result.projectPath} and ${result.manifestPath}.\n`);
  } else {
    process.stderr.write("Usage: dialogue.mjs generate <brief.json> <draft.json> [--submit] | apply <draft.json> <tts/project.yaml>\n");
    process.exitCode = 2;
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Dialogue draft failed"}\n`);
  process.exitCode = 1;
}
