# OpenClaw Generation Adapter

This adapter is optional. Base Tsugite installs do not require OpenClaw.

Use it only when a project explicitly declares `generation.adapter: openclaw`.
Before a real `run`, configure `TSUGITE_OPENCLAW_GENERATE_COMMAND` with a local
or remote-safe executable wrapper as a one-item JSON string array, for example
`["/absolute/path/to/tsugite-openclaw-bridge"]`. The wrapper accepts Tsugite
generation JSON on stdin and returns the standard generation JSON on stdout.
If an existing value contains the executable and arguments separately, move
those fixed arguments into an executable local wrapper and reference only that
wrapper in the JSON array.

The command must download or copy finished media to local files before returning.
It must not return only remote URLs, task ids, or pending job references.

Keep credentials, auth links, raw prompts, and private external content out of
repo files and usage history.
