# Story framework knowledge

`catalog.yaml` is read-only planning data for classic story structures, duration presets, shot design, continuity, editing, and sound principles.

The v2 package ships a byte-for-byte copy at `v2/knowledge/story-frameworks/catalog.yaml`, with the MIT license and source list in `v2/knowledge/story-frameworks/NOTICE.md`. After editing this catalog, run `node v2/scripts/sync-story-catalog.mjs` so the copy and notice stay identical.

Agents should query it through `bin/pipeline story-guides --json` or pass a creative request with `--request` and an optional explicit `--duration`. Recommendations are advisory, never rewrite project files, and never authorize generation or rendering.
