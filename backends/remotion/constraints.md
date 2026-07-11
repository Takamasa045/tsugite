# Remotion backend constraints

- Compile TypeScript and validate composition props before rendering.
- Render execution is gated and begins in Phase 1.
- `article-dialogue-16x9` requires a 16:9 manifest, exactly one left and one right speaker, and a full-duration background clip.
- Character images must be first-class `images[]` assets. Missing poses fall back to `neutral`; do not fake limb changes in code.
- Dialogue lip motion uses three real `mouth_frames` images (closed / half-open / open). Cycle them only for the active speaker; keep the listener closed.
- Keep key text inside the 80px horizontal / 100px vertical safe area and use frame-driven Remotion animation, never CSS animation.
- A project with empty audio arrays is a silent draft. Add and verify dialogue/BGM before treating it as a publishable final.
