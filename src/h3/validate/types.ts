export type H3IssueSeverity = "error" | "warning";

export type H3Issue = {
  code: string;
  message: string;
  severity: H3IssueSeverity;
  path?: Array<string | number>;
};

export type H3ValidationResult = {
  ok: boolean;
  issues: H3Issue[];
  errors: H3Issue[];
  warnings: H3Issue[];
};

export function emptyValidation(): H3ValidationResult {
  return { ok: true, issues: [], errors: [], warnings: [] };
}

export function finalizeValidation(issues: H3Issue[]): H3ValidationResult {
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  return {
    ok: errors.length === 0,
    issues,
    errors,
    warnings
  };
}

export function issue(
  code: string,
  message: string,
  severity: H3IssueSeverity = "error",
  path?: Array<string | number>
): H3Issue {
  return path ? { code, message, severity, path } : { code, message, severity };
}
