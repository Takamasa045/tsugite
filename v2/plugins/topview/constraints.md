# topview source

Labs. Subscription login goes through the official TopView skill CLI (`video_gen.py` and `auth.py status`), not an API key stored in the project. Text-to-video and one local image (`options.mode: image`) are sent as `t2v` and `i2v`. Omni reference, music, voice and templates are not in this subset. The model name is explicit. `max_credits` is the reservation ceiling. If the CLI JSON has no finite `costCredit` or `credits`, the receipt is `credits: null` and the reservation stays uncertain. A missing CLI or a failed `auth.py status` stops before `run`. No generation is submitted in that case, and the failure does not invent a refund.

Offline mode blocks the network entry. Explicit mock mode produces synthetic zero-credit media. Live mode still requires a page-approved plan. This plugin does not read or copy the private credential file.
