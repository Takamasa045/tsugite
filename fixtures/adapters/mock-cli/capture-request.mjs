import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Test-only mock CLI adapter: records the exact adapter payload under the run
 * directory, then emits the same clip output as generate.mjs.
 */
const payload = JSON.parse(await readStdin());
const request = payload.request;

await mkdir(payload.run_dir, { recursive: true });
await writeFile(
  join(payload.run_dir, `.mock-adapter-request-${request.id}.json`),
  `${JSON.stringify({ request, run_id: payload.run_id }, null, 2)}\n`
);

const outputDir = join(payload.run_dir, "generated", request.id);
const outputPath = join(outputDir, `${request.id}-clip.mp4`);
await mkdir(outputDir, { recursive: true });
await copyFile("fixtures/media/render-001.mp4", outputPath);
console.log(
  JSON.stringify({
    request_id: request.id,
    credits: 0.25,
    clips: [
      {
        id: `${request.id}-clip`,
        src: outputPath,
        duration: 1,
        fps: 30,
        resolution: {
          width: 320,
          height: 180
        },
        audio: false
      }
    ],
    metadata: {
      fixture: true,
      captured: true
    }
  })
);

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
