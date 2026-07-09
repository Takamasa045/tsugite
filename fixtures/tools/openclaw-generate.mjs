import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const request = payload.request;
const outputDir = join(payload.run_dir, "generated", request.id);
const outputPath = join(outputDir, `${request.id}-clip.mp4`);
await mkdir(outputDir, { recursive: true });
await copyFile("fixtures/media/clip-001.mp4", outputPath);

console.log(
  JSON.stringify({
    request_id: request.id,
    credits: 2,
    clips: [
      {
        id: `${request.id}-clip`,
        src: outputPath,
        duration: request.duration,
        fps: 30,
        resolution: {
          width: request.aspect === "9:16" ? 1080 : 1920,
          height: request.aspect === "9:16" ? 1920 : 1080
        },
        audio: true
      }
    ],
    metadata: {
      adapter: "openclaw",
      fixture: true
    }
  })
);
