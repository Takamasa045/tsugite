import { projectSchema, type Project } from "./schema.js";
import { readYamlFile } from "../io.js";
import { PipelineError } from "../types.js";

export async function loadProject(path: string): Promise<Project> {
  const parsed = projectSchema.safeParse(await readYamlFile(path));
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
