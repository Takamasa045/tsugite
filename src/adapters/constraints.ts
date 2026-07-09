import { access } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readYamlFile } from "../io.js";
import type { Project } from "../project/schema.js";
import type { Issue, Result } from "../types.js";
import { loadAdapterDefinition } from "./registry.js";

const constraintSchema = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        scope: z.union([z.literal("generation"), z.literal("analysis")]),
        field: z.string().min(1),
        operator: z.union([z.literal("in"), z.literal("min"), z.literal("max")]),
        values: z.array(z.union([z.string(), z.number()])).optional(),
        value: z.union([z.string(), z.number()]).optional(),
        optional: z.boolean().default(false),
        message: z.string().min(1)
      })
    )
    .default([])
});

type ConstraintFile = z.infer<typeof constraintSchema>;
type Comparable = string | number | undefined;

export async function validateGenerationConstraints(
  project: Project,
  adapterDirs = ["adapters"]
): Promise<Result<{}>> {
  if (!project.generation) {
    return { ok: true, issues: [] };
  }

  const adapter = await loadAdapterDefinition(project.generation.adapter, adapterDirs);
  const constraints = await loadConstraints(adapter.root);
  const issues = project.generation.requests.flatMap((request, index) =>
    constraints.checks.flatMap((check) => {
      if (check.scope !== "generation") return [];

      const actual = request[check.field as keyof typeof request] as Comparable;
      const valid = matchesConstraint(actual, check);
      return valid
        ? []
        : [
            {
              code: `adapter.constraint.${check.id}`,
              message: check.message,
              path: `generation.requests.${index}.${check.field}`
            }
          ];
    })
  );

  return issues.length > 0 ? { ok: false, issues } : { ok: true, issues: [] };
}

async function loadConstraints(root: string): Promise<ConstraintFile> {
  const path = join(root, "constraints.yaml");
  if (!(await exists(path))) {
    return { checks: [] };
  }

  return constraintSchema.parse(await readYamlFile(path));
}

function matchesConstraint(
  actual: Comparable,
  check: ConstraintFile["checks"][number]
): boolean {
  if (actual === undefined) return check.optional;
  if (check.operator === "in") return Boolean(check.values?.includes(actual));
  if (typeof actual !== "number" || typeof check.value !== "number") return false;
  if (check.operator === "min") return actual >= check.value;
  return actual <= check.value;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
