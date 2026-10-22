# kling source

Labs. Implements the documented text generation protocol with synthetic HTTP tests and a subscription CLI path; no live paid acceptance is claimed. The CLI default is `kling` (`KLING_CLI` overrides it): `who_am_i` must show a user id before `text_to_video`. A missing CLI or a failed login stops before generation. `max_credits` is the reservation ceiling. A missing or null charge stays uncertain. HTTP remains available when an API origin and credential environment name are set. Offline mode blocks the network entry. Explicit mock mode produces synthetic zero-credit media. Live mode requires an explicitly enabled private connection and a page-approved plan. HTTP keys are read lazily from the chosen environment reference, never written to the project.

Unknown failures/credits hold the reservation; do not infer refunds or automatically repeat submission. Inspect the source package and the connection guide before enabling live mode. A local reservation is not a vendor-enforced remote billing cap.

See the core distribution's docs/connections.md for the dated official references and supported subset. The standalone transport uses no external dependency and accepts an explicitly supplied fetch function, API origin, credentials and trusted download origins.
