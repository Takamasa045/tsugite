# Local Whisper analysis constraints

- This adapter is offline-only. It must not call HTTP services, external APIs, or provider credentials.
- `transcript` and `subtitle_track` require `params.model_path` to resolve to an existing regular local `.pt` file and require a matching lowercase `params.model_sha256`. Model names such as `tiny` are rejected because the Whisper CLI may download them automatically.
- The SHA-256 pin is mandatory because PyTorch `.pt` files are executable deserialization inputs. Use only a model obtained from a trusted source, compute its digest locally, and review any digest change before analysis.
- Runtime model installation and download are outside this adapter. Distributions provide setup guidance and users place models explicitly.
- The Whisper process is started without a shell, in a temporary working directory, with a minimal environment and bounded runtime/output.
- `subtitle_track` uses Whisper's local `translate` task and therefore supports English (`target_language: en`) only.
- High `no_speech_prob` segments are omitted as possible hallucinations and counted in metadata. Transcript-derived edit decisions remain reviewable.
- Filler detections are proposals only: every cut point uses `action: review`. This adapter never edits media, manifests, or Gate state.
- `chapters` and `summary` are deterministic, extractive views of an explicit transcript dependency; they do not claim semantic LLM summarization.
- All emitted ranges remain on the immutable source timeline supplied by Tsugite.
