import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export type RunState = {
  run_id: string;
  status: "planned" | "awaiting_gate_1" | "dry_run";
  updated_at: string;
};

export async function writeState(distDir: string, state: RunState): Promise<string> {
  const runDir = join(distDir, state.run_id);
  await mkdir(runDir, { recursive: true });
  const path = join(runDir, "state.json");
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`);
  return path;
}

export async function readState(path: string): Promise<RunState> {
  return JSON.parse(await readFile(path, "utf8")) as RunState;
}
