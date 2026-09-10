import { randomBytes } from "node:crypto";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { assertDirectory, assertNoSymlinkBetween, assertRegularFile, confinedError, isPathWithin, writeSafeFile } from "./confine.mjs";

export const COMPOSITION_DIRNAME = "editframe-composition";
export const RENDERS_DIRNAME = "editframe-renders";
export const COMPOSITION_MARKER = ".tsugite-editframe-owned";

export async function ensureOwnedCompositionDir(compositionDir, runDir) {
  if (!isPathWithin(runDir, compositionDir)) {
    throw confinedError("composition dir must stay inside runDir", 40);
  }
  await assertNoSymlinkBetween(compositionDir, runDir, "composition dir");
  let info;
  try {
    info = await lstat(compositionDir);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      await mkdir(compositionDir, { recursive: true });
      await writeSafeFile(join(compositionDir, COMPOSITION_MARKER), "editframe\n", compositionDir);
      await assertDirectory(compositionDir, "composition dir");
      return compositionDir;
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw confinedError("composition dir must be a real directory");
  }
  try {
    await assertRegularFile(join(compositionDir, COMPOSITION_MARKER), "composition ownership marker", compositionDir);
  } catch {
    throw confinedError("refusing to overwrite an unowned editframe-composition directory", 40);
  }
  return compositionDir;
}

export async function createFreshOwnedCompositionDir(runDir) {
  const rendersRoot = join(runDir, RENDERS_DIRNAME);
  if (!isPathWithin(runDir, rendersRoot)) {
    throw confinedError("composition dir must stay inside runDir", 40);
  }
  await assertNoSymlinkBetween(rendersRoot, runDir, "renders root");
  await mkdir(rendersRoot, { recursive: true });
  await assertDirectory(rendersRoot, "renders root");
  const id = `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
  const compositionDir = join(rendersRoot, id);
  await assertNoSymlinkBetween(compositionDir, runDir, "composition dir");
  try {
    await mkdir(compositionDir);
  } catch (error) {
    throw confinedError(
      `could not create exclusive composition dir: ${error instanceof Error ? error.message : String(error)}`,
      40
    );
  }
  await writeSafeFile(join(compositionDir, COMPOSITION_MARKER), "editframe\n", compositionDir);
  await assertDirectory(compositionDir, "composition dir");
  return compositionDir;
}
