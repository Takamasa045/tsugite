import { z } from "zod";
import {
  buildIdentityDefinitionDigest,
  buildIdentityVerificationDigest,
  identityDefinitionSchema,
  identityDefinitionSubjectDigest,
  identityVerificationSchema,
  identityVerificationSubjectDigest,
  lockedTextSchema
} from "../../personConsistency/schema.js";
import { migrateIdentityLock, migrateIdentityLockPhaseAtoE } from "../../personConsistency/migration.js";

export {
  buildIdentityDefinitionDigest,
  buildIdentityVerificationDigest,
  identityDefinitionSchema,
  identityDefinitionSubjectDigest,
  identityVerificationSchema,
  identityVerificationSubjectDigest,
  lockedTextSchema,
  migrateIdentityLock,
  migrateIdentityLockPhaseAtoE
};

/** Applicability is explicit; absent evidence is never rewritten to not_applicable. */
export const identityRequirementSchema = z.object({
  requirement: z.enum(["required", "optional", "not_applicable"]),
  reason: z.string().min(1).max(500)
}).strict();
export type IdentityRequirementV1 = z.infer<typeof identityRequirementSchema>;
export const identityContractRequirementSchema = identityRequirementSchema;

export const identityDefinitionContractSchema = identityDefinitionSchema;
export const identityVerificationContractSchema = identityVerificationSchema;
export type IdentityDefinitionContractV1 = z.infer<typeof identityDefinitionSchema>;
export type IdentityVerificationReportV1 = z.infer<typeof identityVerificationSchema>;

/**
 * T04 consumes the person-consistency contract as-is. This helper makes the
 * boundary explicit for callers compiling an MV and does not infer any
 * confirmation or verification from a legacy `locked` flag.
 */
export function parseIdentityDefinitionContract(value: unknown): IdentityDefinitionContractV1 {
  return identityDefinitionSchema.parse(value);
}

export function parseIdentityVerificationReport(value: unknown): IdentityVerificationReportV1 {
  return identityVerificationSchema.parse(value);
}
