import { tmpdir } from "node:os";

export function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}

/**
 * Parent directory for mkdtemp that avoids the macOS /tmp → /private/tmp
 * symlink chain, and does not assume /private/tmp exists on Linux or Windows.
 */
export function durableTempRoot(
  platform: NodeJS.Platform = process.platform,
  systemTemp: string = tmpdir()
): string {
  return platform === "darwin" ? "/private/tmp" : systemTemp;
}
