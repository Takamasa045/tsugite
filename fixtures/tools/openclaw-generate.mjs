const chunks = [];
for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
const request = payload.request;

console.log(
  JSON.stringify({
    request_id: request.id,
    credits: 2,
    clips: [
      {
        id: `${request.id}-clip`,
        src: "fixtures/media/clip-001.mp4",
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
