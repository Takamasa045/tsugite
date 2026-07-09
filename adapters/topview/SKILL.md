# Topview Generation Adapter

Use this adapter when `project.yaml` declares `generation.adapter: topview`.

## Responsibilities

1. Convert each generation request into a Topview video generation task using the installed Topview skill scripts.
2. Before spending credits, provide a dry-run estimate from `adapter.yaml` and the requested duration.
3. Submit real generation only after Coordinator Gate 1 approval.
4. Download completed results to local files under `dist/<run-id>/` before returning success.
5. Return Tsugite generation JSON with `request_id`, `credits`, `clips[]`, and `metadata`.
6. Normalize Topview/API/script failures to the shared exit-code contract.

## Operational Boundary

- Planner and Reviewer roles may run `validate`, `plan`, and `run --dry-run` only.
- Coordinator is the only role allowed to trigger real Topview generation.
- Output QA inspects manifests and downloaded media only. It must not edit or submit tasks.
- Do not store secrets, auth links, raw prompts, or private external content in usage history.

## Topview Mapping

- Text-to-video requests map to the Topview video generation module with `type=t2v`.
- `prompt`, `model`, `duration`, `aspect`, and optional `params.sound` are passed through.
- If Topview returns a board or task id, keep it in `metadata` while still returning local clip files.
