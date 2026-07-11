import { z } from "zod";

export const remediationSchema = z.object({
  default: z.string().min(1),
  darwin: z.string().min(1).optional(),
  linux: z.string().min(1).optional(),
  win32: z.string().min(1).optional()
});

const setupCheckBase = {
  name: z.string().min(1),
  blocking: z.boolean().default(true),
  remediation: remediationSchema
};

export const setupCheckSchema = z.discriminatedUnion("type", [
  z.object({
    ...setupCheckBase,
    type: z.literal("command"),
    command: z.array(z.string().min(1)).min(1),
    capture_version: z.boolean().default(false)
  }),
  z.object({
    ...setupCheckBase,
    type: z.literal("environment"),
    variable: z.string().min(1),
    format: z.enum(["non-empty", "json-command"]).default("non-empty")
  }),
  z.object({
    ...setupCheckBase,
    type: z.literal("manual"),
    detail: z.string().min(1)
  })
]);

export type SetupCheck = z.infer<typeof setupCheckSchema>;

export function remediationForPlatform(
  remediation: z.infer<typeof remediationSchema>,
  platform: NodeJS.Platform
): string {
  if (platform === "darwin") return remediation.darwin ?? remediation.default;
  if (platform === "linux") return remediation.linux ?? remediation.default;
  if (platform === "win32") return remediation.win32 ?? remediation.default;
  return remediation.default;
}
