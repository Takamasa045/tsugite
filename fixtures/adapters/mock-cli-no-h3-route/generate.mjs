import { copyFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const payload = JSON.parse(await readStdin());
const request = payload.request;

if (request.params?.fail_once) {
  const marker = join(payload.run_dir, `.mock-failed-${request.id}`);
  try {
    await writeFile(marker, "failed\n", { flag: "wx" });
    console.error("transient fixture failure");
    process.exit(20);
  } catch {
    // Marker already exists, so the retry can succeed.
  }
}

if (typeof request.params?.exit_code === "number") {
  console.error(request.params.error_output ?? "fixture requested failure");
  process.exit(request.params.exit_code);
}

await mkdir(payload.run_dir, { recursive: true });
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
      fixture: true
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
