# Inspect, choose, preview and review

**Included in alpha.5 and the repository checkout.** Use `plugin guide`. It extends `plugin`, keeping the eight workflow commands
and the existing confirmation-page approval path. It performs no model call,
provider request, install, account change or automatic approval.

The flow helps an agent prepare an existing-local-media edit. It does not claim
that a prompt preset improves quality over an ordinary AI request. It does not
infer edits from arbitrary prose or choose a style through an unseen vision model.
The agent must inspect the actual frames, identify the user's purpose and then
write its observations. The code records those as **reported observations**.

## 1. Inspect the actual source

With a local alpha.5 installation and an existing v2 video folder:

```sh
node ./tsugite-local/node_modules/tsugite/bin/tsugite.mjs plugin guide inspect --project ./my-video
```

For the later examples, replace `npm run --silent v2 --` with that installed
binary command when using the tarball. Private profiles require an explicit
`--private-guide` path in standalone installs. From the repository root:

```sh
npm run --silent v2 -- plugin guide inspect --project ./projects/my-video
```

The video folder needs a valid `tsugite.yaml` with local `use` clips. Generation
tasks are rejected. FFmpeg/FFprobe read the actual files, extract three PNG frames
per clip over its selected playback range (mapping looped positions back into
the actual source), and extract short WAV samples where
source audio or configured tracks are used. Audio samples also follow looped
playback, including offsets at the exact end of a source, and stay within the
selected playback duration. No transcription or semantic vision
judgment is performed. Each material report stores its generated SHA-256 in a
sidecar and the current pointer. Selecting an explicitly named older report also
checks its recorded digest; a selection retains that digest for preview/review. The bounded helper supports up to eight clips, eight
tracks and 512 MiB of regular media. It rejects traversal and project symlinks.

Open every returned `sources[].frames[].path` relative to the video folder.
Inspect the subject, framing and existing text. Listen to the returned samples
when needed. The saved report starts with semantic review/listening pending.
An audio level measurement does not mean anybody listened.

## 2. Record what was seen and choose a purpose

Write `assets/guide-choice.json` in that video folder. This is a schema sketch:
empty frame observations deliberately fail. Replace them only after opening the
actual images, using their returned paths and SHA256 values.

```json
{
  "version": 1,
  "purpose": "talk",
  "preset": "auto",
  "intent": "Keep the speaker visible. No additional captions or music.",
  "overrides": {"captions": "none", "music": "none"},
  "frames": [],
  "audio": {
    "status": "not-listened",
    "observation": "Listening has not yet been performed."
  }
}
```

Each frame observation is `{ "path": "<returned path>", "sha256": "<returned
hash>", "observation": "<what was actually seen>" }`. All sampled frames are
required, without duplicates. Set `audio.status` to `listened` only after actual
listening, with a concrete observation. Optional `inspection` selects a returned
report path; otherwise the current inspection is used. Changed source/config or
altered evidence is rejected.

```sh
npm run --silent v2 -- plugin guide select assets/guide-choice.json --project ./projects/my-video
```

| Purpose / choice | Advisory direction |
| --- | --- |
| `montage` / `clean` | Let the subject and simple cuts carry the material. |
| `talk` / `explain` | Use verified speech timing and requested captions. |
| `music` / `rhythm` | Check real audio and meaningful visual accents; lyrics need supplied words/timing. |

With `preset: auto`, the declared purpose selects one of these three choices.
An explicit no-caption instruction wins and selects `clean`. `captions: none`
removes the project's additional caption entries; `music: none` removes added BGM
tracks, preserving narration and explicitly selected source audio. Existing text
or music baked into a source cannot be removed this way. Conflicting renderer
graphics fail rather than pretending a plain-caption switch removes them.
Presets do not automatically add captions, animation or audio.

Selection writes a project-local knowledge snapshot, adds it to the existing
`knowledge` list and saves the previous configuration. The core binds that text
and changed config to the next plan, invalidating old approvals. It does not edit
approval files. Other requested edits still need the agent to change the actual
supported timeline/settings before planning; a note such as “fewer captions” is
not itself an applied edit.

### Optional private guidance

In a repository checkout, a deliberately created, ignored
`.local/production-guidance.json` can supply a small curated private profile.
A standalone installation does not search a user's home. Either installation can
use an explicitly chosen `--private-guide /absolute/private/profile.json` on
`select`. No original private prompt is bundled with this implementation.

The profile schema is `version: 1`, a project-independent local Markdown `source`
relative to the profile's folder, `common`, and `presets` keyed by `clean`,
`explain`, `rhythm`. Each section has `range: [firstLine, lastLine]` and up to eight
short, newly curated `notes`. The loader reads and hashes the referenced source
sections, rejects symlinks/traversal, and includes only those curated notes and
provenance hashes in the planning snapshot. It never copies the original sections
or full prompt text into knowledge or media. Private profile/source paths remain
only in the local selection record. Keep the private profile/source ignored and
review any project knowledge before sharing a project.

The profile is an explicit snapshot, not an executable script or automatic sync.
If its bytes change before preview/review, select again. Private instructions
cannot approve checks or override explicit no-caption/no-added-music choices.

## 3. Prepare an opening project, then render through normal checks

```sh
npm run --silent v2 -- plugin guide preview --seconds 3 --project ./projects/my-video
```

This creates a **separate**, self-contained project under the video's `previews/`
folder, copying only its required regular local files, with an opening duration
of at most ten seconds. It preserves source offsets, used sound, caption timing
and guidance. It does not render or spend credits. Parent originals remain intact.

Use the returned **absolute `projectDirectory`** for the normal `plan`, `make`
and `export` commands through `npm run --silent v2 --`. Keep the plan page open
and let the human approve the preview plan and clips there. The helper does not
auto-pass clips. This preview currently supports **only the local FFmpeg
renderer**. It rejects optional/native renderers instead of silently replacing
their graphics with a misleading approximation. Burned captions require the
already configured libass-enabled FFmpeg, as in other local exports.

## 4. Review the actual exported preview

Run this on the **parent** video folder:

```sh
npm run --silent v2 -- plugin guide review --project ./projects/my-video
```

It requires an actual export matching the preview's current plan/state and
output hash. It fully decodes the MP4, measures duration/dimensions, checks the
additional subtitle policy, required soft-caption streams and intended sound,
and writes new actual output frames and the entire opening's audio (up to ten
seconds). This includes narration or music starting after the first three seconds.
The first report has `visual.status: pending` and
`readyForHumanFinalReview: false`; measurements alone cannot finish visual QA.

The current quality-report pointer also stores the report digest, so removing
required frames from the JSON cannot reduce the observations needed. These
checks detect changed files; they do not isolate a process with the same OS
account, which can rewrite both evidence and digests.

Observation reports retain the exact hash-verified output frame and audio files
that were inspected; fresh technical measurements still verify the same export.

Open the actual output frames and listen to intended sound. Record
`assets/guide-review.json` with `version: 1`, the returned `outputSha256`, one
`frames` observation for each output frame, and `audio` in the same observation
format as above. Then:

```sh
npm run --silent v2 -- plugin guide review assets/guide-review.json --project ./projects/my-video
```

Stale/altered output, image or audio evidence is rejected. Intended sound keeps
listening pending until listening is reported. A deliberately muted preview can
have no listening requirement, but still needs visual observations. Read
`readyForHumanFinalReview`, not just the CLI's successful-operation `ok` field.
Reported observations are not independent proof of viewing/listening, and sampled
frames are not a full playback. The human must watch the preview and decide in
its confirmation page. The parent full video still requires its own current plan,
checks and export. This workflow does not claim security isolation from another
process using the same OS account.
