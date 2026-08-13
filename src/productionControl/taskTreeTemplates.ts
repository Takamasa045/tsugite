import { z } from "zod";
import { pcError } from "./errors.js";
import {
  PRODUCTION_CONTROL_ROLE_IDS,
  PRODUCTION_CONTROL_TASK_KINDS,
  safeIdSchema,
  type ProductionContract
} from "./schema.js";

export const ROLE_IDS = PRODUCTION_CONTROL_ROLE_IDS;
export const roleIdSchema = z.enum(ROLE_IDS);
export type RoleId = (typeof ROLE_IDS)[number];

export const TASK_KINDS = PRODUCTION_CONTROL_TASK_KINDS;
export const taskKindSchema = z.enum(TASK_KINDS);
export type TaskKind = (typeof TASK_KINDS)[number];

export const templateKindSchema = z.enum(["sequence", "parallel", "bounded_map", "choose_one"]);
export type TemplateKind = z.infer<typeof templateKindSchema>;

const taskTemplateSchema = z.object({
  node_type: z.literal("task"),
  node_id: safeIdSchema,
  kind: safeIdSchema,
  role: safeIdSchema,
  effect: z.enum([
    "read",
    "propose",
    "local-write",
    "external-observe",
    "external-submit",
    "paid",
    "render",
    "gate"
  ]),
  dependencies: z.array(safeIdSchema).max(256).default([]),
  required_contract_fragments: z.array(z.unknown()).max(256).default([]),
  required_artifacts: z.array(z.unknown()).max(256).default([]),
  output_schema: safeIdSchema,
  risk_class: z.enum(["low", "medium", "high"]).default("low"),
  invalidation_tags: z.array(safeIdSchema).max(64).default([])
}).strict();

type TemplateTask = z.infer<typeof taskTemplateSchema>;

export type TaskTreeTemplateNode =
  | {
      node_type: "mission";
      node_id: string;
      template_kind: TemplateKind;
      children: TaskTreeTemplateNode[];
      map_keys?: string[];
    }
  | TemplateTask;

const templateNodeSchema: z.ZodType<TaskTreeTemplateNode> = z.lazy(() => z.union([
  z.object({
    node_type: z.literal("mission"),
    node_id: safeIdSchema,
    template_kind: templateKindSchema,
    children: z.array(templateNodeSchema).max(256),
    map_keys: z.array(safeIdSchema).max(256).optional()
  }).strict(),
  taskTemplateSchema
]));

export const taskTreeTemplateSchema = z.object({
  schema_version: z.literal(1),
  template_id: safeIdSchema,
  root: templateNodeSchema
}).strict();
export type TaskTreeTemplate = z.infer<typeof taskTreeTemplateSchema>;

function task(
  node_id: string,
  kind: TaskKind,
  role: RoleId,
  effect: TemplateTask["effect"],
  output_schema = `${kind}.output`,
  invalidation_tags: string[] = []
): TemplateTask {
  return {
    node_type: "task",
    node_id,
    kind,
    role,
    effect,
    dependencies: [],
    required_contract_fragments: [],
    required_artifacts: [],
    output_schema,
    risk_class: "low",
    invalidation_tags
  };
}

/**
 * A bounded, role-allowlisted baseline tree. Branch expansion is deliberately
 * explicit in the returned template; no request or role can add children.
 */
export function createDefaultTaskTreeTemplate(contract: ProductionContract): TaskTreeTemplate {
  const definitionChildren: TaskTreeTemplateNode[] = [
    task("source-rights", "source-and-rights", "director", "read", "source-and-rights.output", ["assets"])
  ];
  if (contract.contract_slots.music.requirement === "required") {
    definitionChildren.push(task("music-analysis", "music-analysis", "music", "read", "music-analysis.output", ["music", "timeline"]));
  }
  if (contract.contract_slots.lyrics.requirement === "required") {
    definitionChildren.push(task("lyrics-alignment", "lyrics-alignment", "music", "propose", "lyrics-alignment.output", ["lyrics", "timeline"]));
  }
  if (contract.contract_slots.identity.requirement === "required") {
    definitionChildren.push(task("identity-definition", "identity-definition", "identity", "propose", "identity-definition.output", ["identity-definition", "identity"]));
  }

  const executionBranch: TaskTreeTemplateNode = {
    node_type: "mission",
    node_id: "execution-branch-01",
    template_kind: "sequence",
    children: [
      task("generation-batch-01", "generation-batch", "generator", "external-submit", "generation-batch.output", ["generation", "selected-output"]),
      task("branch-critique-01", "branch-critique", "critic", "propose", "branch-critique.output", ["identity-verification", "evidence"])
    ]
  };

  return taskTreeTemplateSchema.parse({
    schema_version: 1,
    template_id: "production-default-v1",
    root: {
      node_type: "mission",
      node_id: "production",
      template_kind: "sequence",
      children: [
        {
          node_type: "mission",
          node_id: "definition",
          template_kind: "parallel",
          children: definitionChildren
        },
        {
          node_type: "mission",
          node_id: "creative",
          template_kind: "sequence",
          children: [
            task("treatment-and-story", "treatment-and-story", "story", "propose", "treatment-and-story.output", ["story"]),
            task("visual-system", "visual-system", "visual", "propose", "visual-system.output", ["visual"]),
            task("production-plan", "production-plan", "director", "propose", "production-plan.output", ["plan"])
          ]
        },
        {
          node_type: "mission",
          node_id: "execution",
          template_kind: "bounded_map",
          map_keys: ["execution-branch-01"],
          children: [executionBranch]
        },
        {
          node_type: "mission",
          node_id: "delivery",
          template_kind: "sequence",
          children: [
            task("edit-and-compose", "edit-and-compose", "editor", "propose", "edit-and-compose.output", ["edit", "timeline"]),
            task("output-qa", "output-qa", "critic", "read", "output-qa.output", ["qa", "identity-verification", "evidence"]),
            task("closeout-learning", "closeout-learning", "learning", "propose", "closeout-learning.output", ["learning"])
          ]
        }
      ]
    }
  });
}

export function assertKnownRole(role: string): asserts role is RoleId {
  if (!roleIdSchema.safeParse(role).success) throw pcError("PC_TREE_INVALID", `unknown role '${role}'`);
}

export function assertKnownTaskKind(kind: string): asserts kind is TaskKind {
  if (!taskKindSchema.safeParse(kind).success) throw pcError("PC_TREE_INVALID", `unknown task kind '${kind}'`);
}
