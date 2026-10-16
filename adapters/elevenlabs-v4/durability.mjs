import * as filesystem from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

export class SubmissionDurabilityError extends Error {
  constructor(code) { super(code); this.code = code; }
}

// New paid submissions require directory fsync. Never silently skip it on an
// unsupported OS. Reading/recovering existing provider work is a separate path.
export function assertSubmissionDurabilitySupported(platform = process.platform) {
  if (!["darwin", "linux"].includes(platform)) {
    throw new SubmissionDurabilityError("submission_durability_unsupported");
  }
}

async function syncDirectory(path, fs) {
  const handle = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isDirectory()) throw new Error("not a directory");
    await handle.sync();
  } finally { await handle.close(); }
}
export async function syncDurableDirectory(path, options = {}) {
  assertSubmissionDurabilitySupported(options.platform);
  await syncDirectory(path, options.filesystem ?? filesystem);
}

// The caller may have just created the run root as well as assets/. Persist
// every ancestor entry instead of assuming an existing directory is durable.
export async function syncSubmissionDirectoryChain(directory, options = {}) {
  assertSubmissionDurabilitySupported(options.platform);
  const fs = options.filesystem ?? filesystem;
  const chain = [];
  for (let current = directory;; current = dirname(current)) {
    chain.push(current);
    if (dirname(current) === current) break;
  }
  for (const path of chain.reverse()) await syncDirectory(path, fs);
}

export async function createDurableSubmissionJournal(directory, requestId, record, options = {}) {
  assertSubmissionDurabilitySupported(options.platform);
  const fs = options.filesystem ?? filesystem;
  let handle;
  try {
    await syncSubmissionDirectoryChain(directory, options);
    handle = await fs.open(join(directory, `${requestId}.submission.jsonl`), "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`);
    await handle.sync();
    // File fsync does not make its new directory entry durable.
    await syncDirectory(directory, fs);
    return handle;
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Preserve even an empty/partially written marker. Its presence is never
    // evidence that a later invocation is allowed to submit again.
    throw new SubmissionDurabilityError(error?.code === "EEXIST"
      ? "submission_already_exists_or_unwritable" : "submission_not_durable");
  }
}
