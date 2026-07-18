import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export function locateMediaUseSkill(environment = process.env, cwd = process.cwd()) {
  const configured = environment.TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR?.trim();
  const candidates = [
    ...(configured ? [configured] : []),
    join(cwd, ".agents", "skills", "media-use"),
    join(cwd, ".codex", "skills", "media-use"),
    join(cwd, ".claude", "skills", "media-use"),
    join(homedir(), ".agents", "skills", "media-use"),
    join(homedir(), ".codex", "skills", "media-use"),
    join(homedir(), ".claude", "skills", "media-use")
  ];

  for (const candidate of candidates) {
    const root = resolve(candidate);
    const audioScript = join(root, "audio", "scripts", "audio.mjs");
    const waitScript = join(root, "audio", "scripts", "wait-bgm.mjs");
    if (existsSync(join(root, "SKILL.md")) && existsSync(audioScript) && existsSync(waitScript)) {
      return { root, audioScript, waitScript };
    }
  }
  return undefined;
}
