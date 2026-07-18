# HyperFrames-first BGM / SFX

`hyperframes-media` is a dedicated Tsugite audio adapter. It runs only after Gate 1 approval, writes audio inside `dist/<run-id>/`, and adds the resolved tracks to the assembled manifest before Gate 2 QC.

## Policy

- BGM `mode: generate`: use the official HyperFrames `media-use` Lyria/MusicGen route.
- BGM `mode: retrieve`: use the authenticated HeyGen music catalog. It does not silently generate on a miss.
- SFX: use HeyGen catalog retrieval when authenticated, otherwise the bundled `media-use` SFX library.
- ElevenLabs: never selected or used by this adapter. `ELEVENLABS_API_KEY` is removed from the child environment.
- Fallback: `fail` only. Missing requested audio stops before Gate 2 instead of switching providers.
- Cloud BGM: off by default. Set `audio.params.allow_cloud_bgm: true` only when Lyria and its billing/auth boundary were reviewed at Gate 1.
- Network disclosure: the adapter declares request metadata as its maximum transfer scope and lists only optional HeyGen/Google credential variables. Gate 1 displays this boundary even when the local MusicGen/bundled-SFX path is expected; `doctor` does not require optional cloud credentials.

HyperFrames owns playback/mixing. The separately installed `media-use` Skill owns BGM/SFX resolution and generation.

## Setup

From the repository root:

```sh
npm ci
npx --no-install hyperframes skills update media-use
node bin/pipeline doctor --config fixtures/projects/hyperframes-audio.yaml --json
```

If the installer places `media-use` outside `.agents/skills`, `.codex/skills`, or `.claude/skills`, point Tsugite to its directory:

```sh
export TSUGITE_HYPERFRAMES_MEDIA_SKILL_DIR=/absolute/path/to/media-use
```

`doctor` checks only the CLI and Skill files. It does not generate audio, authenticate, install MusicGen models, or consume provider credits.

## Project configuration

```yaml
edit:
  backend: hyperframes

audio:
  adapter: hyperframes-media
  fallback: fail
  bgm:
    id: main-bgm
    mode: generate
    prompt: warm cinematic underscore, restrained percussion, no vocals
    start: 0
    end: 30
    volume: 0.2
  sfx:
    - id: opening-whoosh
      prompt: soft whoosh
      start: 0.25
      volume: 0.35
  params:
    allow_cloud_bgm: false
    bgm_timeout_ms: 3600000
```

`prompt` on an SFX request is a concrete lookup intent; current HyperFrames `media-use` resolves SFX rather than generating it.

## Safe flow

```sh
node bin/pipeline validate --config projects/<job>/project.yaml --json
node bin/pipeline plan --config projects/<job>/project.yaml --json
node bin/pipeline review --config projects/<job>/project.yaml --open --json
node bin/pipeline run --config projects/<job>/project.yaml --dry-run --json
```

After reviewing the audio prompt, placement, provider boundary, and expected setup at Gate 1, the Coordinator can approve and run. The adapter waits for detached BGM generation, requires every requested track to exist inside the run directory, then Gate 2 records ffprobe and SHA-256 evidence. No audio is generated during validate, plan, review, dry-run, or doctor.
