import { chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(desktopRoot, "runtime");
const iconRoot = join(desktopRoot, "assets", "icon");
const nodePtyTarget = `${process.platform}-${process.arch}`;
const nodePtyUnpackPattern = `{**/node_modules/node-pty/build/Release/**,**/node_modules/node-pty/prebuilds/${nodePtyTarget}/**}`;

const macSignIdentity = process.env.MACOS_SIGN_IDENTITY;
const canNotarize = Boolean(
  process.env.APPLE_ID
  && process.env.APPLE_APP_SPECIFIC_PASSWORD
  && process.env.APPLE_TEAM_ID
);
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const appSourceFiles = new Set([
  "/package.json",
  "/src/main.mjs",
  "/src/preload.mjs",
  "/src/agent-terminal.mjs",
  "/src/lifecycle.mjs",
  "/src/process-runner.mjs",
  "/src/runtime.mjs"
]);

function ignoreOutsideAppAllowlist(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!normalized || normalized === "/src") return false;
  if (normalized === "/node_modules" || normalized.startsWith("/node_modules/")) return false;
  return !appSourceFiles.has(normalized);
}

function ensureNodePtyHelperPermissions(buildPath, _electronVersion, platform, arch, callback) {
  if (platform === "win32") {
    callback();
    return;
  }
  const helpers = [
    join(buildPath, "node_modules", "node-pty", "build", "Release", "spawn-helper"),
    join(buildPath, "node_modules", "node-pty", "prebuilds", `${platform}-${arch}`, "spawn-helper")
  ];
  Promise.all(helpers.map((helper) => chmod(helper, 0o755))).then(() => callback(), callback);
}

const packagerConfig = {
  // Keep JavaScript in ASAR. node-pty contains platform-native binaries and
  // helper executables, so unpack only rebuilt and target-specific runtime files.
  asar: { unpack: nodePtyUnpackPattern },
  beforeAsar: [ensureNodePtyHelperPermissions],
  extraResource: [runtimeRoot],
  appBundleId: "jp.azumimusuhi.tsugite",
  appCategoryType: "public.app-category.video",
  icon: iconRoot,
  ignore: ignoreOutsideAppAllowlist,
  ...(macSignIdentity ? { osxSign: { identity: macSignIdentity } } : {}),
  ...(canNotarize ? {
    osxNotarize: {
      tool: "notarytool",
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID
    }
  } : {})
};

const squirrelConfig = {
  name: "Tsugite",
  authors: "Azumi Musuhi",
  description: "Tsugite local video workflow desktop application",
  ...(windowsCertificateFile && windowsCertificatePassword ? {
    certificateFile: windowsCertificateFile,
    certificatePassword: windowsCertificatePassword
  } : {})
};

export default {
  packagerConfig,
  makers: [
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {}
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: { format: "ULFO" }
    },
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: squirrelConfig
    }
  ]
};
