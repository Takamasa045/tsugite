import { writeFile } from "node:fs/promises";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
await writeFile(payload.outputPath, "not a media container\n");
await writeFile(
  payload.reportPath,
  `${JSON.stringify({
    backend: "unprobeable",
    output_path: payload.outputPath,
    manifest_path: payload.manifestPath,
    duration_seconds: 1,
    width: 320,
    height: 180,
    fps: 30
  })}\n`
);
