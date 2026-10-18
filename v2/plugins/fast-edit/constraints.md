# Fast Edit selection compiler

Pure local selection-to-project compiler. Input JSON: version 1, format, optional
name, and segments [{path:"assets/clip.mp4", start:0, end:1, audio:false}].
Returns a proposal only; it never overwrites tsugite.yaml, approves a check,
generates media or sends data. Review the JSON then copy the desired project
fields into tsugite.yaml and create a new plan. Full media bounds are checked
by the core during planning. Native/v1 effect graphs are not silently imported.
