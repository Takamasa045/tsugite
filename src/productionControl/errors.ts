export type ProductionControlErrorCode =
  | "PC_SCHEMA_INVALID"
  | "PC_SECRET_OR_PATH"
  | "PC_CANONICAL_INVALID"
  | "PC_PATH_UNSAFE"
  | "PC_ARTIFACT_DUPLICATE"
  | "PC_ARTIFACT_MISMATCH"
  | "PC_ARTIFACT_NOT_FOUND"
  | "PC_EVENT_CHAIN"
  | "PC_EVENT_CONFLICT"
  | "PC_EVENT_TAMPERED"
  | "PC_INVALID_TRANSITION"
  | "PC_SNAPSHOT_CONFLICT"
  | "PC_RECOVERY_INVALID";

/** Error boundary for the production-control shadow foundation. */
export class ProductionControlError extends Error {
  readonly code: ProductionControlErrorCode;
  readonly details?: Readonly<Record<string, string | number | boolean>>;

  constructor(
    code: ProductionControlErrorCode,
    message: string,
    details?: Readonly<Record<string, string | number | boolean>>
  ) {
    super(message);
    this.name = "ProductionControlError";
    this.code = code;
    this.details = details;
  }
}

export function pcError(
  code: ProductionControlErrorCode,
  message: string,
  details?: Readonly<Record<string, string | number | boolean>>
): ProductionControlError {
  return new ProductionControlError(code, message, details);
}
