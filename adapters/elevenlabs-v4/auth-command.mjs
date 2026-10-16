import { executeAuthAction } from "./auth-api.mjs";
import { adapterErrorEnvelope } from "../error-envelope.mjs";
try {
  let input = "";
  for await (const chunk of process.stdin) { input += chunk; if (input.length > 100_000) throw new Error("oauth_arguments_invalid"); }
  process.stdout.write(`${JSON.stringify(await executeAuthAction(JSON.parse(input)))}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify(adapterErrorEnvelope(error?.code ?? error?.message))}\n`);
  process.exitCode = error?.exitCode ?? 30;
}
