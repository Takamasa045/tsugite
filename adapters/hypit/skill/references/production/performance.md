# Presenting an existing performance

Read this to place existing A-roll full frame, in an inset, beside graphics, or in a changing layout.
[Timeline](timeline.md) places the prepared Takes; Performance directs their picture. Media Items
instead take independently supplied material, just as Typography supplies text while Caption uses
Script's words. A-roll may be audio-only, leaving the picture to other components.

## Broad treatment, local Uses

```svml
<import as="performance" from="@hypit/performance@1"/>
<performance:Style id="full" frame={layout.full} appearance={recipes.media.presenter}/>
<performance:Style id="side" frame={layout.side} appearance={recipes.media.presenter}/>
<performance:Track id="presenter" timeline={program.timeline} canvas={canvas}>
  <performance:Use style={full}/>
  <performance:Use during={story.selection.explanation} style={side}/>
</performance:Track>
```

The excerpt assumes the Timeline, Canvas, Frames and Media appearance Recipe exist. The ordinary
Style shares Media fitting, crop anchors, rounded clipping, border and sample appearance. Include
`presenter.visual` and a [Sound](sound.md) presentation separately in Film. Sound obtains the same
placed material and handles gain, silence and explicit source blending.

An unqualified Use sets the broad treatment. Later matching Uses replace the whole choice locally;
this is the same broad/local rule as Caption styling. Performance selects frame Windows; Caption
selects authored display units. Separate presentation Tracks remain independent.

Use supports `during`, `at` + `for`, `until` + `for`, and `start` + `end`. A Moment can start a
fixed-duration change. No matching rule contributes no picture; an intentionally empty winning
rule stays empty. Source gaps and audio-only Takes need no visual stand-in. Extend Timeline's end
for a code-authored closing passage, and place its graphics there directly.

## Give a new visual behavior a Style

A recurring presenter motion can be a project Style. It receives the Timeline, Canvas and original
Use Window, plus its own explicit parameters. Think of a specific reusable behavior, such as a
full-frame viewport moving into a side Frame. The family owns its trajectory and exposes the inputs
that make it useful; arbitrary Styles do not automatically morph into one another.

Declare the initial treatment, then the settled treatment starting at the event, then the short
movement Use last. It covers the start of the settled treatment and naturally reveals that treatment
when finished. Matching endpoint geometry comes from shared Frames or parameters. The source video
continues playing throughout; partial coverage does not reset its animation clock.

An overlap transition is also a Use. For two Takes, its Window can run from the next Segment's start
to the previous Segment's end:

```svml
<performance:Use style={mix}
  start-source={story.segment.next} start="segment.start"
  end-source={story.segment.previous} end="segment.end"/>
```

Define `mix` in the chosen family with explicit outgoing/incoming sources. Those roles are separate
from the occurrence Window. The ordinary Style layers simultaneous footage in declaration order;
an overlap by itself does not create a transition.

For implementation, a Style uses `performanceStyle(fragment, bindings)` from
`@hypit/hypit/performance`. The fragment receives `timeline`, `canvas`, `window` and family-owned typed
inputs, and exports `visual: VisualTrack`. Bind extra inputs to resolved author references; they
become explicit graph dependencies at each Use. Use `projectTimelineMedia` for source identities,
program spans and source offsets, and the shared temporal helpers for additional events. All existing
structural/browser drawing capabilities remain available. [Track authoring](track-authoring.md) and
[component drawing](component-visuals.md) explain that implementation path.

When presenter and graphics share a larger coordinated scene, give that scene its own component.
Choose the abstraction by the behavior worth reusing; a project Style does not have to become an
official preset before it can be used.
