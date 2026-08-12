import { describe, expect, it } from "vitest";
import {
  isExtendedWindowsPath,
  isUncPath,
  isWindowsDrivePath,
  isWindowsDriveRelativePath
} from "../src/productionControl/windowsPathLex.js";
import { assertMigrationPathLexicalSafe } from "../src/productionControl/rc/pathSafety.js";

describe("Windows lexical path fail-closed (macOS-testable)", () => {
  it("detects mixed-separator UNC and extended UNC", () => {
    expect(isUncPath("\\\\server\\share\\file")).toBe(true);
    expect(isUncPath("//server/share/file")).toBe(true);
    expect(isUncPath("\\\\server/share/file")).toBe(true);
    expect(isUncPath("//server\\share\\file")).toBe(true);
    expect(isUncPath("\\\\?\\UNC\\server\\share\\file")).toBe(true);
    expect(isUncPath("//?/UNC/server/share/file")).toBe(true);
    expect(isUncPath("C:\\Users\\x")).toBe(false);
    expect(isUncPath("\\\\.\\C:\\foo")).toBe(false);
  });

  it("detects device namespace and extended-length paths", () => {
    expect(isExtendedWindowsPath("\\\\?\\C:\\foo")).toBe(true);
    expect(isExtendedWindowsPath("//?/C:/foo")).toBe(true);
    expect(isExtendedWindowsPath("\\\\.\\C:\\foo")).toBe(true);
    expect(isExtendedWindowsPath("//./C:/foo")).toBe(true);
    expect(isExtendedWindowsPath("C:\\Users\\x")).toBe(false);
  });

  it("separates drive-absolute from drive-relative forms", () => {
    expect(isWindowsDrivePath("C:\\Users\\x")).toBe(true);
    expect(isWindowsDrivePath("C:/Users/x")).toBe(true);
    expect(isWindowsDrivePath("C:foo")).toBe(false);
    expect(isWindowsDriveRelativePath("C:foo")).toBe(true);
    expect(isWindowsDriveRelativePath("C:..\\outside")).toBe(true);
    expect(isWindowsDriveRelativePath("C:\\Users\\x")).toBe(false);
  });

  it("rejects mixed UNC, device, and drive-relative migration candidates", () => {
    expect(() => assertMigrationPathLexicalSafe("\\\\server/share/a", "mig")).toThrow(
      /UNC|PC_PATH_UNSAFE|not allowed/
    );
    expect(() => assertMigrationPathLexicalSafe("\\\\.\\C:\\foo", "mig")).toThrow(
      /extended|device|not allowed|PC_PATH_UNSAFE/
    );
    expect(() => assertMigrationPathLexicalSafe("C:foo", "mig")).toThrow(
      /drive-relative|not allowed|PC_PATH_UNSAFE/
    );
  });
});
