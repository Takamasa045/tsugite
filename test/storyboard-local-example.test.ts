import { cp, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { main } from "../src/cli.js";
import { validateProject } from "../src/project/validateProject.js";

const SOURCE = resolve("examples/storyboard-local");
const HOME_KEY = "TSUGITE_PROJECTS_HOME";

async function capture(args: string[]) {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const status = await main(args);
  const stdout = log.mock.calls.map((call) => String(call[0])).join("\n");
  const stderr = error.mock.calls.map((call) => String(call[0])).join("\n");
  log.mockRestore();
  error.mockRestore();
  return { status, stdout, stderr };
}

describe("examples/storyboard-local", () => {
  const previousHome = process.env[HOME_KEY];

  afterEach(() => {
    if (previousHome === undefined) delete process.env[HOME_KEY];
    else process.env[HOME_KEY] = previousHome;
  });

  it("is a zero-credit local sample with storyboard stills, a character, captions, and motion", async () => {
    const validation = await validateProject(join(SOURCE, "project.yaml"));
    const project = await readFile(join(SOURCE, "project.yaml"), "utf8");
    const manifest = JSON.parse(await readFile(join(SOURCE, "manifest.json"), "utf8"));

    expect(validation.ok).toBe(true);
    expect(validation.issues).toEqual([]);
    expect(project).toContain("name: 絵コンテ見本");
    expect(project).toContain("slug: storyboard-local");
    expect(project).not.toContain("generation:");
    expect(manifest.images.map((image: { id: string }) => image.id)).toEqual([
      "hikari-neutral",
      "hikari-wave",
      "shot-garden",
      "shot-wave"
    ]);
    expect(manifest.speakers[0]).toMatchObject({ id: "hikari", display_name: "ひかり" });
    expect(manifest.captions).toHaveLength(2);
    expect(manifest.captions[0].visual.motion.entrance.preset).toBe("fade");
    expect(manifest.presentation.motion_design.summary).toContain("手を振る");
    expect(manifest.provenance.every((item: { credits?: number }) => item.credits === 0)).toBe(true);
  });

  it("passes isolated validate, plan, and review without touching repo projects/", async () => {
    const root = await mkdtemp(join(tmpdir(), "tsugite-storyboard-local-"));
    const home = join(root, "projects");
    const work = join(root, "work");
    await cp(SOURCE, work, { recursive: true });
    process.env[HOME_KEY] = home;

    const config = join(work, "project.yaml");
    const validated = await capture(["validate", "--config", config, "--json"]);
    expect(validated.status).toBe(0);
    expect(JSON.parse(validated.stdout)).toMatchObject({
      ok: true,
      command: "validate",
      launcher_visible: true
    });

    const planned = await capture(["plan", "--config", config, "--json"]);
    expect(planned.status).toBe(0);
    const planPayload = JSON.parse(planned.stdout);
    expect(planPayload).toMatchObject({ ok: true, command: "plan" });
    expect(planPayload.plan.estimated_credits).toBe(0);

    const reviewed = await capture(["review", "--config", config, "--json"]);
    expect(reviewed.status).toBe(0);
    const reviewPayload = JSON.parse(reviewed.stdout);
    expect(reviewPayload).toMatchObject({
      ok: true,
      command: "review",
      gate: "gate-1",
      gate_state: "unchanged"
    });

    const html = await readFile(reviewPayload.review_path, "utf8");
    const data = JSON.parse(await readFile(reviewPayload.review_data_path, "utf8"));
    expect(data.summary.title).toBe("絵コンテ見本");
    expect(data.characters[0]).toMatchObject({ id: "hikari", display_name: "ひかり" });
    expect(data.storyboard).toHaveLength(2);
    expect(data.storyboard[0].image).toMatchObject({ id: "shot-garden" });
    expect(data.motion_design.status).toBe("declared");
    expect(html).toContain("<h1>絵コンテ見本</h1>");
    expect(html).toContain("ひかり");
    expect(html).toContain("おはよう");
    expect(html).toContain("手を一度振る");
    expect(html).toContain("エージェントに「承認」「ここを直したい：〜」「中止」と伝えてください");
    expect(html).not.toContain("仮の構成図を表示しています");
    expect(html).not.toContain("<button");

    const repoProjects = await readdir("projects").catch(() => []);
    expect(repoProjects).not.toContain("storyboard-local");
  });
});
