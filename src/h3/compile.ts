/** Compatibility shim — compiler lives in videoPromptDirector. */
export {
  compileH3Request,
  compileProjectH3,
  applyH3ExecutionRouteProfile,
  mapMode,
  h3IssueToProjectIssue,
  hashPromptGuideContent,
  enrichH3Compilation,
  enrichH3CompilationsForProject,
  H3_WORKFLOW_ID,
  H3_WORKFLOW_VERSION,
  H3_ROUTE_PROFILE_REQUIRED_CODE,
  type H3Compilation,
  type H3Lineage,
  type H3PromptGuideSource,
  type CompileH3RequestResult,
  type CompileProjectH3Result,
  type CompileH3Options,
  type ModeMapping
} from "../videoPromptDirector/compile.js";
