import { describe, expect, it } from "vitest";
import { runGenerationModelPreflight } from "../src/adapters/modelPreflight.js";
import type { AdapterDefinition } from "../src/adapters/registry.js";

const request = {
  id: "future-shot",
  operation: "video" as const,
  prompt: "private prompt must not be returned",
  model: "future-model",
  params: {}
};

function fixtureAdapter(script?: string): AdapterDefinition {
  return {
    name: "fixture",
    kind: "cli",
    class: "generation",
    connection_requirement: "required",
    dry_run_estimate: true,
    batch: false,
    credit_estimate: { per_request: 0, per_second: 0 },
    retry: { max_attempts: 0, retryable_exit_codes: [] },
    exit_code_map: { "0": "ok", "40": "invalid_request" },
    checks: { setup: [] },
    root: "fixtures/adapter",
    ...(script ? {
      model_preflight: {
        executable: process.execPath,
        args: ["-e", script],
        input: "stdin-json" as const
      }
    } : {})
  };
}

describe("generation model preflight", () => {
  it("reports provider-deferred validation as non-billing without claiming full compatibility", () => {
    const result = runGenerationModelPreflight(fixtureAdapter(`
          let input = "";
          process.stdin.on("data", chunk => input += chunk);
          process.stdin.on("end", () => {
            const payload = JSON.parse(input);
            process.stdout.write(JSON.stringify({
              request_id: payload.request.id,
              status: "provider-validation-required",
              source: "fixture-runtime",
              model: payload.request.model,
              operation: payload.request.operation || "video",
              runtime_version: "9.9.9",
              checked_parameters: ["model"]
            }));
          });
        `), [request]);

    expect(result).toMatchObject({
      ok: true,
      fullyValidated: false,
      billingAction: false,
      generationSubmitted: false,
      requests: [{
        request_id: "future-shot",
        status: "provider-validation-required",
        source: "fixture-runtime",
        model: "future-model"
      }]
    });
    expect(JSON.stringify(result)).not.toContain("private prompt");
  });

  it("fails closed when the adapter does not declare a preflight command", () => {
    expect(runGenerationModelPreflight(fixtureAdapter(), [request])).toMatchObject({
      ok: false,
      billingAction: false,
      generationSubmitted: false,
      requests: [],
      issues: [{ code: "models.preflight_unavailable" }]
    });
    expect(runGenerationModelPreflight({ ...fixtureAdapter(), kind: "mcp-agent" }, [request])).toMatchObject({
      ok: false,
      issues: [{ code: "models.preflight_unavailable" }]
    });
  });

  it.each([
    ["command failure", "process.exit(1)", "models.preflight_failed"],
    ["invalid JSON", "process.stdout.write('not-json')", "models.preflight_output_invalid"],
    [
      "mismatched request id",
      "process.stdout.write(JSON.stringify({request_id:'another',status:'compatible',source:'fixture-runtime',operation:'video'}))",
      "models.preflight_output_invalid"
    ]
  ])("fails closed on %s", (_label, script, issueCode) => {
    expect(runGenerationModelPreflight(fixtureAdapter(script), [request])).toMatchObject({
      ok: false,
      fullyValidated: false,
      billingAction: false,
      generationSubmitted: false,
      requests: [],
      issues: [{ code: issueCode }]
    });
  });

  it("adds a generic issue when an adapter reports incompatibility without details", () => {
    const result = runGenerationModelPreflight(fixtureAdapter(
      "process.stdout.write(JSON.stringify({request_id:'future-shot',status:'incompatible',source:'fixture-runtime',operation:'video'}))"
    ), [request]);

    expect(result).toMatchObject({
      ok: false,
      fullyValidated: false,
      requests: [{ status: "incompatible" }],
      issues: [{ code: "models.incompatible" }]
    });
  });

  it("preserves safe adapter issues and recognizes fully validated requests", () => {
    const incompatible = runGenerationModelPreflight(fixtureAdapter(
      "process.stdout.write(JSON.stringify({request_id:'future-shot',status:'incompatible',source:'fixture-runtime',operation:'video',issues:[{code:'models.option_invalid',message:'duration is unsupported'}]}))"
    ), [request]);
    expect(incompatible.issues).toEqual([{
      code: "models.option_invalid",
      message: "duration is unsupported"
    }]);

    const compatible = runGenerationModelPreflight(fixtureAdapter(
      "process.stdout.write(JSON.stringify({request_id:'future-shot',status:'compatible',source:'fixture-runtime',operation:'video'}))"
    ), [request]);
    expect(compatible).toMatchObject({
      ok: true,
      fullyValidated: true,
      issues: []
    });
  });
});
