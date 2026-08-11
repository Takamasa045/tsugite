import { z } from "zod";
import { sha256Canonical, withoutField } from "../canonical.js";
import { digestSchema, safeIdSchema } from "../schema.js";

const projectRelativePathSchema = z.string().min(1).max(1_024).refine((value) => {
  if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  if (value.includes("\\")) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}, "project-relative regular-file path required");

const mediaEvidenceSchema = z.object({
  mime: z.string().min(1).max(256),
  duration_ms: z.number().int().nonnegative().optional(),
  streams_digest: digestSchema.optional()
}).strict();

const assetProvenanceSchema = z.object({
  source: z.enum(["user", "generated", "licensed", "project-created", "unknown"]),
  note: z.string().min(1).max(2_000).optional(),
  usage_confirmed: z.union([z.boolean(), z.literal("unknown")])
}).strict();

export const assetEntrySchema = z.object({
  asset_id: safeIdSchema,
  kind: z.enum(["video", "image", "audio", "text", "font", "data"]),
  project_relative_path: projectRelativePathSchema,
  sha256: digestSchema,
  byte_size: z.number().int().nonnegative(),
  media_evidence: mediaEvidenceSchema.optional(),
  roles: z.array(z.string().min(1).max(120)).max(64),
  provenance: assetProvenanceSchema,
  external_send: z.enum(["allowed", "forbidden", "needs-human"])
}).strict();
export type AssetEntryV1 = z.infer<typeof assetEntrySchema>;

const assetContractBaseSchema = z.object({
  schema_version: z.literal(1),
  contract_id: safeIdSchema,
  revision: z.number().int().nonnegative(),
  assets: z.array(assetEntrySchema).max(10_000)
}).strict();

export const assetContractSchema = assetContractBaseSchema.extend({
  digest: digestSchema
}).strict().superRefine((value, context) => {
  const ids = value.assets.map((asset) => asset.asset_id);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["assets"], message: "asset ids must be unique" });
  }
  const expected = sha256Canonical(withoutField(value, "digest"));
  if (expected !== value.digest) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["digest"], message: "asset contract digest mismatch" });
  }
});
export type AssetContractV1 = z.infer<typeof assetContractSchema>;
export type AssetContract = AssetContractV1;

export type AssetContractInput = Omit<AssetContractV1, "schema_version" | "digest">;

export function createAssetContract(input: AssetContractInput): AssetContractV1 {
  const { schema_version: _schemaVersion, digest: _digest, ...raw } = input as AssetContractInput & { schema_version?: unknown; digest?: unknown };
  const base = assetContractBaseSchema.parse({ schema_version: 1, ...raw });
  return assetContractSchema.parse({ ...base, digest: sha256Canonical(base) });
}

export function assetContractDigest(value: AssetContractV1): string {
  const parsed = assetContractSchema.parse(value);
  return parsed.digest;
}

export const assetSchema = assetEntrySchema;
