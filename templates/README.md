# Templates

Reusable project shapes live here when an example is too specific and a blank starter is more useful.

Use `examples/` for copyable, working fixtures. Use `templates/` for reusable structures that still require user-specific media, prompts, or settings before validation.

Available templates:

- `event-promo/`: planning and completion-notes scaffold for a short event promo. It requires a multi-cut shot plan, a one-clip TTS proof before batch synthesis, separate horizontal/vertical composition decisions, and explicit good/bad/retry notes. Generated media stays in the copied `projects/<job>/` directory.
- `blog-dialogue-60s/`: article source -> two-speaker Japanese script -> 60-second 16:9 Remotion presentation. It includes a deterministic manifest builder, an original Shiba pose set, subtitle/LRC assets, and a local-only slot for the user's teacher character.
- `qa-dialogue/`: FAQ-style Q&A list (`qa.json`) -> two-speaker 16:9 Remotion presentation with QUESTION/ANSWER cards. Duration is derived from intro, per-question timing, and outro. Reuses the `article-dialogue-16x9` preset.
