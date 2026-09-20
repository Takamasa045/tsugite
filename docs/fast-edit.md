# Jev Fast Edit v1

Fast Edit is an edit mode of the existing Tsugite pipeline. Select a renderer with `edit.backend` only. The existing backend contract, source Manifest, assembly, Production Control, Gate 1/2/3, Gate 3 output QA, Artifact Store and review Viewer remain in use. There is no Renderer Registry or `--renderer` option. The Editframe examples workbench remains a separate demo.

```yaml
edit:
  backend: remotion # or hyperframes / editframe
  fast_edit:
    enabled: true
    beat_seconds: 2.5 # optional
```

Configure the existing `analysis` pipeline with `local-whisper-analysis`, one transcript request for each source clip, a local model path and its SHA-256. It already emits word timestamps. Fast Edit consumes the raw analysis artifact; it does not install models, transcribe through a cloud service, or infer timing from text. Every transcript must match the current source file hash and analysis range. Local source clips, embedded audio and ordinary local BGM/narration/SFX tracks are supported. Combining Fast Edit with generation, another editorial/composition policy, legacy presentation, images, speakers or clip motion is rejected explicitly.

```sh
node bin/pipeline analyze --config <project.yaml> --actor coordinator
# Prepare the bounded question artifact only (no external call):
node bin/pipeline fast-edit --config <project.yaml> --actor coordinator
# Live decisions through the existing cached jev-mcp@0.4.0, explicit external inference:
node bin/pipeline fast-edit --config <project.yaml> --actor coordinator --allow-external-analysis
# Alternatively, reproduce a Jev response fixture without external inference:
node bin/pipeline fast-edit --config <project.yaml> --actor coordinator --decisions <answers.json>
node bin/pipeline plan --config <project.yaml>
node bin/pipeline review --config <project.yaml>
```

Then follow the normal human Gate 1 → coordinator run → Gate 2 → coordinator render → output QA → human Gate 3 sequence. Fast Edit preparation never approves a Gate, changes the source Manifest, spends generation credits, or renders. CLI preparation writes create-only artifacts under the run's `fast-edit/artifacts/` using the existing Artifact Store. Validation compiles them in memory; the approved assembly persists `manifest.json` and `fast-edit-edl.json`. Changing source bytes, analysis, beat segmentation or decisions invalidates the corresponding approval input. Use a new `run_id` for revised decisions. The generated review document exposes the global decisions and all beat decisions beside the existing storyboard.

The fast path is local analysis → deterministic beat splitter → a single `jev_ask` call → strict intent validation → Manifest/EDL compilation. No Codex/Claude/Grok prompt agent is in this execution path. The MCP default is 64 questions; the isolated child receives `JEV_MAX_QUESTIONS` equal to the validated request size. A 16-beat request contains exactly 117 questions: 7 per beat and 5 global. Jev questions are independent. Missing answers, unknown options, cross-beat emphasis IDs, and `review`/`abstain` results fail closed, retaining the raw response for inspection. A response fixture is test input, not evidence of a live autonomous decision.

## Neutral intent

`manifest.fast_edit` and the EDL contain `version: 1`, `global`, timed `words` with stable IDs, and ordered contiguous `beats`. Each beat has `word_ids` and seven edit decisions. Unknown fields, including backend-specific executable/component fields, are rejected.

- Global style: `energetic`, `minimal`, `editorial`.
- Source color: `source`, `warm`, `cool`, `mono`.
- Caption style: `bold`, `outlined`, `clean`.
- Energy: `high`, `medium`, `low`; controls entrance/effect duration (0.22 / 0.38 / 0.65s) while preserving source speech timing.
- Progress: `bottom`, `top`, `none`.
- Text effect: `none`, `pop`, `rise`, `typewriter`.
- Transition: `cut`, `fade`, `zoom`, `wipe`; deterministic entrance transitions without shortening/overlapping the source audio.
- Zoom: `none`, `medium` (1.15x), `close` (1.32x), centered on the source; this does not perform face tracking.
- SFX: `none`, `whoosh`, `pop`, `chime`, synthesized deterministically and mixed with the original source audio.
- Emphasis: a word ID in the same beat or `null`; active only within that word's timestamp.

The 18 cards are `keyword`, `quote`, `stat`, `question`, `list`, `steps`, `comparison`, `definition`, `highlight`, `warning`, `tip`, `checklist`, `timeline`, `counter`, `title`, `lower_third`, `callout`, `cta`. They use transcript words, never invented statistics or free-form Jev text. `visual_needed: false` intentionally hides the card; it is not a backend fallback.

All three backends declare the full `capabilities.fast_edit` set. Missing any required flag blocks the mode. Shared pure frame math defines geometry, emphasis, style and timing; each backend renders using its existing native surface. Color treatment uses run-owned local source derivatives so extracted-video composition preserves the same source pixels. The source Manifest/files stay intact. Shared FFmpeg mixing preserves source trims, track timing/volume and SFX on all three. Editframe uses clone-aware `ef-timegroup.onFrame` callbacks and an opaque stage so transparent transitions cannot retain old frames. Fast Edit selects the official `foreign-object` capture path; experimental native capture produced unstable vertical frames. Its older, non-Fast-Edit capability limits remain unchanged. Common parity is at 30fps, both 16:9 and 9:16.

## Reproducible local parity verification

Install ordinary repository dependencies and the optional pinned Editframe runtime first. Tests use a synthetic local video/audio fixture plus identical word timestamps and Jev decision fixtures for all backends. They do not call a provider or create human Gate approvals.

```sh
npm run build
node scripts/verify-fast-edit.mjs verification/evidence/fast-edit-parity
node scripts/check-fast-edit-pixels.mjs verification/evidence/fast-edit-parity
```

Requires FFmpeg/ffprobe and Tesseract (for independently reading burned-in captions). The first command produces six native `final.mp4` files and `output.mp4` delivery copies, native render reports, EDLs, source/decision hashes, full decode checks, and existing Gate 3 QA reports. The second checks all 18 captions by OCR, 32 sampled frames per aspect/backend including transition boundaries, and identical decoded audio with SFX across all outputs. Native H.264 encoders differ, so per-frame RGB mean absolute error must remain below 12/255 against the Remotion reference; it is never averaged over a whole video to conceal a failed beat. `report.json.ok` becomes true only when the additional visual/caption/audio checks pass. This does not substitute for a human production Gate or claim a full real-time watch/listen.
