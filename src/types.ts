export type Issue = {
  code: string;
  message: string;
  path?: string;
  adapter_error?: import("../adapters/error-envelope.mjs").AdapterErrorEnvelope;
};

export type Result<T> =
  | {
      ok: true;
      issues: [];
    } & T
  | {
      ok: false;
      issues: Issue[];
    } & Partial<T>;

export class PipelineError extends Error {
  readonly issues: Issue[];

  constructor(issue: Issue) {
    super(issue.message);
    this.name = "PipelineError";
    this.issues = [issue];
  }
}
