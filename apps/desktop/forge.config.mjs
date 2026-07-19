import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = join(desktopRoot, "runtime");
const iconRoot = join(desktopRoot, "assets", "icon");

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

const packagerConfig = {
  // Keep the Electron shell in ASAR, but stage the spawned CLI, its cwd and
  // production node_modules as real files under process.resourcesPath/runtime.
  asar: true,
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
