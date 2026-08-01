/**
 * Pure-function Windows regression coverage for destinationLock trusted anchors.
 * Injects path.win32 so macOS CI still exercises drive/case rules without a Windows host.
 */
import { win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
  chooseTrustedPathAnchorWith,
  type TrustedPathAnchorPathApi
} from "../src/project/destinationLock.js";

const win32PathApi: TrustedPathAnchorPathApi = {
  resolve: win32.resolve.bind(win32),
  relative: win32.relative.bind(win32),
  isAbsolute: win32.isAbsolute.bind(win32),
  parse: win32.parse.bind(win32),
  sep: win32.sep
};

describe("chooseTrustedPathAnchorWith (Windows path.win32 pure helper)", () => {
  it("falls back to the candidate drive root when trusted bases are on another drive", () => {
    // Process on C:, TSUGITE_PROJECTS_HOME on D: — must not pick C:\ via resolve(sep).
    const anchor = chooseTrustedPathAnchorWith(
      "D:\\tsugite\\projects",
      [
        "C:\\cwd",
        "C:\\Users\\Me",
        "C:\\Users\\Me\\AppData\\Local\\Temp"
      ],
      win32PathApi
    );
    expect(anchor).toBe("D:\\");
  });

  it("picks the longest trusted base on the same drive despite case differences", () => {
    const anchor = chooseTrustedPathAnchorWith(
      "c:\\users\\me\\projects\\job",
      [
        "C:\\Users",
        "C:\\Users\\Me",
        "C:\\Temp"
      ],
      win32PathApi
    );
    expect(anchor).toBe("C:\\Users\\Me");
  });

  it("does not treat C:\\foo as containing C:\\foobar (prefix collision)", () => {
    const foobarChild = chooseTrustedPathAnchorWith(
      "C:\\foobar\\x",
      ["C:\\foo", "C:\\other"],
      win32PathApi
    );
    // Neither base contains the candidate; fallback is the candidate drive root.
    expect(foobarChild).toBe("C:\\");

    const longest = chooseTrustedPathAnchorWith(
      "C:\\foobar\\x",
      ["C:\\foo", "C:\\foobar"],
      win32PathApi
    );
    expect(longest).toBe("C:\\foobar");
  });
});
