# pixverse source

Labs. Implements the documented V6 text, image-to-video, first/last-frame
transition, extend, upscale, prompt-only modify and image-reference Fusion
protocols with synthetic HTTP tests; no live paid acceptance is claimed. Image
and transition tasks take project-local PNG/JPEG/WebP files in `make.inputs`.
Extend, upscale and modify take a local MP4/MOV/WebM (modify may add up to
three stills). Those files are hashed into the plan and are not timeline clips.
Live video modes upload through `/openapi/v2/media/upload`. Aspect is omitted
for image/transition because framing follows the uploaded stills. Offline mode
blocks the network entry. Explicit mock mode produces synthetic zero-credit
media and validates the same request/payload contract as planning. Live quotes
use dated V6 generated-duration rates for text/image/transition/extend/image
reference (audio-off 5/7/9/18, audio-on 7/9/12/23), 5 credits/s of source
duration for upscale, and 8/10/12 credits/s of source duration for modify
360/540/720p. `max_credits` below that estimate is rejected. Images over 20 MB
and videos over 32 MB fail at planning. Video-reference Fusion, masks, motion
control, templates, voice and PixVerse music are unimplemented. Verify actual
charges before paid use. Live mode requires an explicitly enabled private connection, a service
budget, and a page-approved plan. Keys are read lazily from the chosen
environment reference, never written to the project. Credentials never belong in
source options.

Unknown failures/credits hold the reservation; do not infer refunds or automatically repeat submission. Inspect the source package and the connection guide before enabling live mode. A local reservation is not a vendor-enforced remote billing cap.

See the core distribution's docs/connections.md for the dated official references and supported subset. The standalone transport uses no external dependency and accepts an explicitly supplied fetch function, API origin, credentials and trusted download origins.
