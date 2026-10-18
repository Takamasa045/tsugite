# Fast Edit compiler and local renderer

Pure local selection-to-project compiler. Input JSON: version 1, format, optional
name, and segments [{path:"assets/clip.mp4", start:0, end:1, audio:false}].
Returns a proposal only; it never overwrites tsugite.yaml, approves a check,
generates media or sends data. Review the JSON then copy the desired project
fields into tsugite.yaml and create a new plan. Full media bounds are checked
by the core during planning.

An optional fast_edit decision object selects the independent Fast Edit renderer.
It validates timed words/beats, 18 cards, word emphasis, text effects, transitions,
zoom, deterministic SFX, progress, style/color/energy and caption style. The
versioned object becomes renderer_options in the approved plan; it contains no
executable code or external assets. The frame-time scene and deterministic WAV
helper are adapted from Tsugite v1 under MIT (LICENSE included); no v1 core import
is used. Existing v1 Fast Edit decisions migrate through a declared plugin hook.

The real renderer uses the same explicitly installed Remotion peers and existing
browser as the optional Remotion package; its license conditions apply. No peers
or browser are downloaded automatically. Real 18-card/SFX output was verified on
one Mac under network denial. The zero-cost mock produces clearly labeled fixture
media and does not claim the real effects. Other native editor graphs can be
archived with an explicit final-copy migration; they are never silently applied.
