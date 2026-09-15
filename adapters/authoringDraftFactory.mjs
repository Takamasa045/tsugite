import { getAuthoringUiLaunchSpec, listDraftAuthoringAdapterIds } from "./authoringUiRegistry.mjs";

export function getAuthoringDraftSpec(adapterId) {
  const spec = getAuthoringUiLaunchSpec(adapterId);
  if (!spec?.createDraft || !spec.canonicalLayout) return undefined;
  return Object.freeze({
    adapterId: spec.id,
    engineAdapterId: spec.engineAdapterId ?? spec.id,
    unusedHistoricalBackend: spec.unusedHistoricalBackend ?? "remotion",
    state: spec.canonicalLayout.state,
    workspace: spec.canonicalLayout.workspace
  });
}

export function defaultDraftAuthoringAdapterId() {
  const ids = listDraftAuthoringAdapterIds();
  return ids.length === 1 ? ids[0] : undefined;
}

export { listDraftAuthoringAdapterIds };
