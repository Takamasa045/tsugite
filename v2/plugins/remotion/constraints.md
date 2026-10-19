# Remotion renderer

Optional community plugin, never required by the first offline sample. Install
its matching peer packages separately. Set TSUGITE_BROWSER to an existing local
Chrome/Chromium executable; this implementation never downloads a browser.
Sequential video, trims, loops, source sound, music/voice/SFX and plain captions
use the same versioned timeline as the local renderer. Mock uses the copied
zero-cost FFmpeg fixture renderer and is not evidence of Remotion execution.
`execution: mock` does not need Remotion peers or TSUGITE_BROWSER. Live/offline
planning fails closed without matching peer packages and an absolute existing
browser path. Plain `soft` captions are muxed as a selectable MP4 subtitle
stream without changing video pixels. Live `burn` captions are drawn in the
Remotion composition (not FFmpeg libass). The mock fixture still needs libass
for `burn`. The confirmation page does not add an external caption track in
burn mode. `init --from-v1` does not import v1 `edit.backend: remotion`.

Remotion has its own source-available license. Free eligibility depends on the
organization/team's total headcount and use case, not the number of users who
personally operate it. Shared contractors/entities and automation can affect
requirements. Forking does not remove those conditions. Review:
https://www.remotion.dev/docs/license/faq and the license of the installed release.
No license purchase, account change, provider call or cloud rendering is made.
