/**
 * Lexical Windows path classifiers. Pure string checks for fail-closed
 * UNC / device / drive / drive-relative forms, including mixed separators.
 * Platform-independent: safe to unit-test on macOS.
 */

const DEVICE = /^(?:\\\\[.]\\|\/\/\.\/)/i;
const EXTENDED = /^(?:\\\\\?\\|\/\/\?\/)/i;
const EXTENDED_UNC = /^(?:\\\\\?\\unc\\|\/\/\?\/unc\/)/i;
const DRIVE_ABSOLUTE = /^[A-Za-z]:[\\/]/;
const DRIVE_RELATIVE = /^[A-Za-z]:(?![\\/])/;

function backslashForm(path: string): string {
  return path.replace(/\//g, "\\");
}

/** `\\?\` / `//?/` extended-length, plus `\\.\` / `//./` device namespace. */
export function isExtendedWindowsPath(path: string): boolean {
  return EXTENDED.test(path) || DEVICE.test(path);
}

/**
 * UNC share path, including mixed separators (`\\server/share`) and
 * extended UNC (`\\?\UNC\server\share`). Device namespace is not UNC.
 */
export function isUncPath(path: string): boolean {
  if (DEVICE.test(path)) return false;
  if (EXTENDED_UNC.test(path)) return true;
  const normalized = backslashForm(path);
  return /^\\\\[^\\]+\\[^\\]+/.test(normalized);
}

/** `C:\` or `C:/` absolute drive path. */
export function isWindowsDrivePath(path: string): boolean {
  return DRIVE_ABSOLUTE.test(path);
}

/**
 * Drive-relative `C:foo` (cwd of that drive). These escape containment
 * because they resolve outside the lexical parent.
 */
export function isWindowsDriveRelativePath(path: string): boolean {
  return DRIVE_RELATIVE.test(path);
}
