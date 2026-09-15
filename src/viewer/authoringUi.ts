import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export type AuthoringUiLaunchResult = {
  url: string;
  host: string;
  port: number;
  reused: boolean;
  pid?: number;
};

async function loadLaunchHelper(): Promise<{
  ensureAuthoringUi: (input: { adapterId: string; productionRoot: string }) => Promise<AuthoringUiLaunchResult>;
  readLiveAuthoringUiUrl: (productionRoot: string, adapterId: string) => Promise<string | undefined>;
}> {
  const modulePath = join(REPO_ROOT, "adapters", "authoringUiLaunch.mjs");
  return await import(pathToFileURL(modulePath).href) as {
    ensureAuthoringUi: (input: { adapterId: string; productionRoot: string }) => Promise<AuthoringUiLaunchResult>;
    readLiveAuthoringUiUrl: (productionRoot: string, adapterId: string) => Promise<string | undefined>;
  };
}

export async function ensureRegisteredAuthoringUi(input: {
  adapterId: string;
  productionRoot: string;
}): Promise<AuthoringUiLaunchResult> {
  const helper = await loadLaunchHelper();
  return helper.ensureAuthoringUi(input);
}

export async function readLiveRegisteredAuthoringUiUrl(
  productionRoot: string,
  adapterId: string
): Promise<string | undefined> {
  const helper = await loadLaunchHelper();
  return helper.readLiveAuthoringUiUrl(productionRoot, adapterId);
}
