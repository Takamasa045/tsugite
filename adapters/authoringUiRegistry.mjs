import { fileURLToPath } from "node:url";
import { join } from "node:path";

const adaptersRoot = fileURLToPath(new URL(".", import.meta.url));

const SPECS = Object.freeze({
  hypit: Object.freeze({
    id: "hypit",
    modulePath: join(adaptersRoot, "hypit", "productionCliMain.mjs"),
    argvPrefix: Object.freeze(["ui"]),
    productionArg: "--production",
    portArg: "--port",
    listenRelativePath: ".tsugite/authoring/ui-listen.json",
    readyPath: "/state",
    nodeImport: "tsx",
    createDraft: true,
    engineAdapterId: "authoring-adapter",
    unusedHistoricalBackend: "remotion",
    canonicalLayout: Object.freeze({
      state: ".tsugite/authoring/state.json",
      workspace: "hypit-workspace"
    })
  })
});

export function getAuthoringUiLaunchSpec(adapterId) {
  if (typeof adapterId !== "string" || adapterId.length === 0) return undefined;
  return SPECS[adapterId];
}

export function isRegisteredAuthoringAdapter(adapterId) {
  return getAuthoringUiLaunchSpec(adapterId) !== undefined;
}

export function listDraftAuthoringAdapterIds() {
  return Object.freeze(
    Object.keys(SPECS).filter((id) => SPECS[id]?.createDraft === true)
  );
}
