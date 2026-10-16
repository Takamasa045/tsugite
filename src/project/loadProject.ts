import { projectSchema, type Project } from "./schema.js";
import { readYamlFile } from "../io.js";
import { PipelineError } from "../types.js";

export async function loadProject(path: string): Promise<Project> {
  const input = await readYamlFile(path);
  if (input && typeof input === "object" && Object.hasOwn(input, "billing")) {
    throw new PipelineError({ code: "project.billing_runtime_only", message: "billingは保存済み見積から構成する実行時情報です。project.yamlから送信許可を指定できません。", path: "billing" });
  }
  const parsed = projectSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PipelineError({
      code: "project.schema",
      message: issue?.message ?? "invalid project file",
      path: issue?.path.join(".")
    });
  }

  return {
    ...parsed.data,
    run_id: parsed.data.run_id ?? parsed.data.slug
  };
}
