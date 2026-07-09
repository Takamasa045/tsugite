const payload = JSON.parse(await readStdin());

console.log(JSON.stringify(payload.request.params.output));

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
