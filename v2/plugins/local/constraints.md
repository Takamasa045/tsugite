# Local media

Requires FFmpeg/FFprobe on PATH, with libx264. No network, keys, downloads or
provider credits. The sample is synthetic testsrc footage created locally.
Renderer: sequential trimmed/looped video, still-image holds (PNG/JPEG/WebP with
explicit seconds), optional source audio, BGM/narration/SFX mixing, fit-to-frame
conversion and timed plain captions. MP4 subtitle tracks are
the default; the review page also serves session-bound WebVTT. Burn-in requires
an FFmpeg build with libass and is rejected during planning when unavailable.
TSUGITE_FFMPEG/TSUGITE_FFPROBE select existing executables; no installation or
shared-library repair is attempted. Inputs must be local regular media. No
arbitrary effect/native-edit graphs are accepted. This plugin does not
claim endorsement by a vendor. FFmpeg's build and codec licenses still apply.
