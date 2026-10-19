# elevenlabs source

Labs. Implements the documented text generation protocol with synthetic HTTP tests; no live paid acceptance is claimed. Offline mode blocks the network entry. Explicit mock mode produces synthetic zero-credit media and validates the same request/payload contract as planning, including an explicit `voice_id`. Live quotes require an explicit positive `max_credits`; they do not invent a charge from character count. Live mode requires an explicitly enabled private connection, a service budget, and a page-approved plan. Keys are read lazily from the chosen environment reference, never written to the project. Credentials never belong in source options. The synchronous endpoint has no durable task id; unknown credits stay reserved.

Unknown failures/credits hold the reservation; do not infer refunds or automatically repeat submission. Inspect the source package and the connection guide before enabling live mode. A local reservation is not a vendor-enforced remote billing cap.

See the core distribution's docs/connections.md for the dated official references and supported subset. The standalone transport uses no external dependency and accepts an explicitly supplied fetch function, API origin, credentials and trusted download origins.
