# Local Whisper transcription

Labs. Uses whisper.cpp's installed whisper-cli and an explicitly chosen local
model file. No model download, API service, credentials or credit use. Input
should be a compatible local audio file (convert to 16-bit WAV if needed).
Set TSUGITE_WHISPER to the existing executable. The binary/model combination
needs its own real-device transcript verification; mock is synthetic text only.
Reference: https://github.com/ggml-org/whisper.cpp
