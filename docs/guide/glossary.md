# Words you'll see

The [English README](../../README.md) lists five to seven terms. This page keeps the official names. Command names, keys, and filenames stay in code.

| Plain wording | Official name | Meaning |
| --- | --- | --- |
| Production | `project` (`project.yaml`) | One video's folder and settings. The launcher lists the required `name` field. |
| Plan check / footage check / final check | Gate 1 / Gate 2 / Gate 3 | Human stops. The launcher shows “Open Gate 1 review” style actions and a Waiting count. |
| Footage list | manifest | The production data for clips, audio, captions, and edit intent. |
| Connection to a generation service | adapter | The selected PixVerse, Kling, or other generation path. Unselected providers are never installed automatically. |
| Edit engine | backend | The local renderer that assembles the video (default Remotion), chosen with `edit.backend`. |
| Generate / export | `run` / `render` | Generation may bill a provider. Export is local and unpaid but can take time. Both run only after Coordinator and a prior Gate. |
| Preferences & Learnings | feedback | Recorded notes. Lifecycle is observed → recurring → promoted → verified. Approval only permits a later implementation task; it does not rewrite prompts, templates, or rules. |

Launcher labels to match: production list, Waiting, Preferences & Learnings. Previous technical README text is in [docs/reference.md](../reference.md).
