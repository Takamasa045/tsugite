# pixverse source

Labs. Implements the documented V6 text, image-to-video and first/last-frame
transition protocols with synthetic HTTP tests; no live paid acceptance is
claimed. Image and transition tasks take project-local PNG/JPEG/WebP files in
`make.inputs` (one still, or first then last). Those files are hashed into the
plan and are not timeline clips. Live image mode uploads the still, then calls
the image generate endpoint; transition uploads both stills. Aspect is omitted
for image/transition because framing follows the uploaded stills. Offline mode
blocks the network entry. Explicit mock mode produces synthetic zero-credit
media and validates the same request/payload contract as planning. Live quotes
use the dated per-quality text-to-video estimate for all three modes and reject
a `max_credits` below that estimate; verify actual image/transition rates before
paid use. Live mode requires an explicitly enabled private connection, a service
budget, and a page-approved plan. Keys are read lazily from the chosen
environment reference, never written to the project. Credentials never belong in
source options.

Unknown failures/credits hold the reservation; do not infer refunds or automatically repeat submission. Inspect the source package and the connection guide before enabling live mode. A local reservation is not a vendor-enforced remote billing cap.

See the core distribution's docs/connections.md for the dated official references and supported subset. The standalone transport uses no external dependency and accepts an explicitly supplied fetch function, API origin, credentials and trusted download origins.
