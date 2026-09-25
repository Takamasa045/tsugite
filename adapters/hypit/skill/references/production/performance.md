# Presenting an existing performance

Read this to present footage already placed on the [Timeline](timeline.md), including a pure A-roll
work whose picture stays full-frame. Performance obtains that footage and its current source position;
Uses direct how it appears. [Media Items](media-presentation.md) explicitly receive independent material
and playback choices. Picture size, subject and transparency do not select between these paths.

For a short drama, spoken scene or direct address, retain Script and the accepted SemanticTakes even
when a single full-frame Style is the complete visual treatment. A-roll's semantic role continues
through later reframing or coverage. An audio-only performance needs [Sound](sound.md) but supplies
no picture for Performance.

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

## Preserve source playback and the original Use time

Timeline placement determines which source frame is current. If a Take starts at program second 5,
a Use beginning at second 7 sees source second 2. Hiding and showing footage does not restart it.
The Style also retains the original Use Window for its animation, even where another Use covers
part of it or a Take boundary cuts through it. Visibility, source playback and animation progress
are separate facts.

The ordinary Style draws available visual sources in Timeline declaration order, later above
earlier. Timeline itself retains them all. An audio-only Take contributes no picture; a gap remains
empty. Overlapping sources do not automatically crossfade, and separate Performance Tracks can
intentionally show the same content in multiple places.

For simultaneous views of the current performance, share this Timeline mapping and let each visual
owner choose its crop and treatment. A close foreground and enlarged background can therefore show
the same source instant. A replay starting from a chosen earlier moment has a different playback
relationship: supply that prepared source to Media or the scene explicitly. Neither use requires
another copy of the speech in Film.

## Choose the picture actually held by the Timeline

A Take contains the selected prepared picture, including any background removal already performed.
Changing its Frame, crop or Style does not restore an original background. Keep the original output
and bind it explicitly when a presentation needs it. [Media preparation](media.md#keep-original-and-processed-material-explicit)
owns that material choice and any preparation adapter.

For example, a cutout can continue in a lower corner through Performance while an opening Media Item
shows the retained original from the start of the same passage. If the handoff occurs later inside
a Take, both pictures need the corresponding source position. A project Style or scene can receive
the original explicitly and use the Timeline projection to sample it, when the two inputs share
that frame mapping. It does not search for hidden variants or assume two independent clips align.
Route the intended voice once through Sound. A direct cut between those materials needs no animated
journey between their Frames. If the intended effect instead dissolves an original into its cutout,
both views must depict the corresponding source instant and align the subject through their fitting,
crop and transforms. Equal destination Frames alone do not establish equal subject geometry.

## Give a new visual behavior a Style

A recurring presenter motion can be a project Style. It receives the Timeline, Canvas and original
Use Window, plus its own explicit parameters. Think of a specific reusable behavior, such as a
full-frame viewport moving into a side Frame. The family owns its trajectory and exposes the inputs
that make it useful; arbitrary Styles do not automatically morph into one another.

For a direct switch, a local Use selects the new treatment at its semantic event. For a continuous
handoff, declare the initial treatment, then the settled treatment starting at the event, then the
short movement Use last. It covers the start of the settled treatment and reveals that treatment
when finished. Match both endpoint Frames and their source fitting/crop through shared values so the
subject meets the intended view. The source video continues playing throughout; partial coverage
does not reset its animation clock. Additional actions that answer other words receive their own
projected events, as described in
[component design](component-design.md#let-meaning-drive-the-behavior).

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
