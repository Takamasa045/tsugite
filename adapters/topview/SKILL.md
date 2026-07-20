# TopView MCP Generation Adapter

Use this adapter when `project.yaml` declares `generation.adapter: topview`.

## Responsibilities

1. Convert image, video, music, and voice requests into the corresponding official TopView MCP tool call.
2. Before spending credits, provide a dry-run estimate from `adapter.yaml` and the requested duration.
3. Submit real generation only after Coordinator Gate 1 approval.
4. Download completed results to local files under `dist/<run-id>/` before returning success.
5. Return Tsugite generation JSON with `request_id`, `credits`, `clips[]`, `images[]`, `audio[]`, and non-secret `metadata`.
6. Normalize TopView MCP failures to the shared exit-code contract.

## Operational Boundary

- Planner and Reviewer roles may run `validate`, `plan`, and `run --dry-run` only.
- Coordinator is the only role allowed to trigger real Topview generation.
- Output QA inspects manifests and downloaded media only. It must not edit or submit tasks.
- Do not store secrets, auth links, raw prompts, or private external content in usage history.

## TopView Mapping

- `image` maps to `topview_generate_image`; text-to-image and image edit are selected from the approved inputs.
- `video` and `reference` map to `topview_generate_video`; text-to-video, image-to-video, and omni reference are selected from pinned inputs.
- `music` maps to `topview_generate_music`; `voice` maps to `topview_generate_voice` and requires `params.voice_id`.
- `motion-control` maps to the video MCP tool. `template` routes the explicit `remove-background`, `product-avatar`, and `avatar-video` contracts.
- Fetch models and required parameters from `topview_get_generation_config` at execution time. Do not treat a static catalog as execution capability.
- If TopView returns a board or task id, keep it in `metadata` while still returning downloaded local media.
