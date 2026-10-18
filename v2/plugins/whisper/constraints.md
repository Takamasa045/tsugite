# Local Whisper transcription

Labs. Uses whisper.cpp's installed whisper-cli and an explicitly chosen local
model file. No model download, API service, credentials or credit use. Input
should be a compatible local audio file (convert to 16-bit WAV if needed).
Set TSUGITE_WHISPER to the existing executable. The binary/model combination
needs its own real-device transcript verification; mock is synthetic text only.
Reference: https://github.com/ggml-org/whisper.cpp

Real CPU transcription is verified on one Mac with an existing large-v3-turbo-q8_0 model and bundled public speech, under network denial. Audio/video input is normalized to 16 kHz mono WAV. Binary/model digests are returned as evidence; no model bytes or personal media are distributed. Other model/host combinations remain unverified.
