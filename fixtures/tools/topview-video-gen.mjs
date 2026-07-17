import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
const firstFrame = value("--first-frame");
const outputDir = resolve(value("--output-dir"));
const runDir = dirname(dirname(outputDir));

if (value("--type") !== "i2v" || !firstFrame || !resolve(firstFrame).startsWith(join(runDir, "assets", "generation-inputs"))) {
  process.exit(40);
}

mkdirSync(outputDir, { recursive: true });
const generated = spawnSync("ffmpeg", [
  "-y", "-f", "lavfi", "-i", "color=black:s=720x1280:d=5:r=30",
  "-c:v", "libx264", "-pix_fmt", "yuv420p", join(outputDir, "video_1.mp4")
], { stdio: "ignore" });
if (generated.status !== 0) process.exit(20);
process.stdout.write(JSON.stringify({
  status: "success",
  taskId: "topview-task-fixture",
  boardId: "topview-board-fixture",
  costCredit: 5,
  videos: [{ status: "success", filePath: "https://example.invalid/video.mp4" }]
}));
