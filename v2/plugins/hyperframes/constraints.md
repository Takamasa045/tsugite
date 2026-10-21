# HyperFrames local renderer

Plain captions follow the shared mode: `soft` muxes a selectable MP4 subtitle
stream; `burn` draws timed HTML captions. The page adds VTT only for soft mode.

Optional labs adapter for an explicitly selected, already installed HyperFrames 0.8.173 CLI, GSAP and Chromium browser. No install, upgrade, auth, browser download, feedback or cloud command is invoked. Telemetry and update checks are disabled through the documented environment overrides. Vendor config/render counters may still be used by the upstream CLI.

Still-image holds are rejected at planning; this renderer copies inputs as
`clip-i.mp4`. A real Mac fixture passed the same plan/page/make/export path with timed captions, looping BGM and SFX. External networking and writes to existing vendor configuration were denied for that test. Runtime, GSAP and browser identity are bound to the plan. Other runtimes/hosts need separate verification. This adapter does not imply vendor endorsement.
