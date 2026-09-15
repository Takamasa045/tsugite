# Writing a project Track

Read this when a production needs new graphic structure, state or rendering behavior. Begin from
what the viewer should perceive and what should follow a changed performance.
[Component design](component-design.md) develops that idea into a useful author interface and a
coherent treatment in the actual composition.
[Composing Tracks](tracks.md) covers existing Track roles; [vocabulary](vocabulary.md) covers discovery
and project package ownership. [Caption authoring](caption-authoring.md) covers the speech-text case.

## Start with the author-visible behavior

Prefer semantic inputs when the component responds to the words or performance. A comparison can occupy
a Selection; a verdict can trigger a Moment; the whole board can live for a Segment. Expose those
choices on the Surface and pass their projected Windows or Instants to the implementation. This
keeps the component useful when a new performance changes the pace. In an authored animation,
content events carry their own reading rhythm. Their Instants and Windows enter the same component
inputs; durations and frame offsets direct how a change unfolds.

Write a small intended Source use before implementing it. A new score strip might have one Style,
an outer Window, preset scores and score-changing Moments. Decide whether its items appear briefly,
remain after activation, replace a previous state, or rearrange the layout. Those differences define
the component more usefully than a long list of decorative parameters.

This existing answer-strip vocabulary illustrates a concrete choice:

```svml
<emoji:Track id="answers" timeline={speech.timeline} canvas={canvas}
  style={answer-style} placeholder={question-icon} during="program">
  <emoji:Item id="known" icon={known-icon} preset="true"/>
  <emoji:Item id="surprise" icon={answer-icon} at={story.moment.reveal}/>
</emoji:Track>
```

Its outer Window owns visibility; source order owns slots; preset answers exist at the beginning;
each Moment changes only its slot and the answer persists. A chart or scoreboard can instead own
repeated updates or simultaneous events.

## Keep selection, projection and consumption distinct

Script names meaning: a Selection, Segment or Moment. The Timeline supplies where that
event falls after its prepared media is placed. The consuming component's Surface lowers its authored timing
form into a projection subgraph, which resolves an Instant or Window in the program's frame space.
The component's own Fragment and Producers then decide what to do with that value.

```text
Script Selection / Segment / Moment + Timeline
                         ↓ component Surface creates projection
                Timeline + Window / Instant
                         ↓ component Fragment / Producer consumption
              media occupancy, graphic state, sound or effect
```

This separation lets one Moment drive an answer reveal, a short sound and a flash. Each consumer
receives its own appropriate projection, but all refer to the same authored event. Changed speech
moves the event without asking each component to search for a word or inspect the Script parser.

Use `resolveTemporalContext` from `@hypit/hypit/temporal-markup` to resolve the component's
`timeline` input. Pass that same Timeline to its Fragment and Producers, alongside projected
Instants/Windows. A component can combine literal times and word-bound events without switching time
models. The installed `examples/semantic-composition/packages/chat-scene` demonstrates repeated
content children with their own events and a picture drawn entirely in code.

For a Window consumer, `during={story.selection.example}` can take both semantic boundaries.
`at={story.moment.answer} for="8f"` starts a short effect at a Moment. An Instant consumer may accept
`at={story.moment.answer}` with no duration because it owns a state transition. Read the actual
Surface: identical-looking `at` attributes do not imply identical consumption. [Script and semantic
time](../creation/script-and-time.md#bind-meaning-to-script-identities) describes the shared author
forms; the component chooses which of them fit its behavior.

## Separate lifetime, activation and persistent state

For a board that stays on screen, author its outer Window independently of individual reveals.
Then decide what its children mean:

- an Item window may mean “draw only during this interval,” as with ordinary Media;
- an activation window may stage an item's entrance and movement, after which it remains in a board;
- a Moment may replace a question mark with an answer that persists until the outer Window ends;
- a preset item may already occupy the initial state and need no reveal trigger.

Document that meaning in the component. `preset` is the answer strip's package-owned initial-state
concept. An answer strip consumes an Instant for a reveal that persists, while Media consumes a
Window for occupancy. Expose timing inputs whose consumption matches the behavior.

The interview's project emoji strip illustrates this design: one outer Window, ordered answer
items, a placeholder asset and one icon per answer. Each Moment changes its own slot. The Track does
not decide when the spoken answer occurred; it consumes the already projected event.

## Use the Timeline's existing placement model

The [Timeline](timeline.md) places intact prepared Takes at native speed. Sequential placement,
head/interior/tail space and simultaneous Takes share the same data type. A project scene consumes
its range, media samples and semantic events through ordinary projection helpers.

A different material operation, such as trimming or retiming a performance, changes the local media
and its preparation. A display operation, such as crossfading two available sources, belongs to the
visual scope owning them. Keep these decisions distinct so a layout change preserves source timing
and a material change establishes truthful local evidence.

## Make spatial decisions equally explicit

CanvasSpace identifies the coordinate system. SpatialFrame, anchors, extents and fitting describe
where content goes and how its intrinsic shape occupies that place. RegionTimeline supplies authored
per-frame regions in a chosen Canvas. These are distinct from Timeline, which owns the complete time range.

Keep image dimensions, placement and crop transformations visible so a measured head or a reserved
MG area maps into the actual composition. Do not hardcode a global 9:16 canvas, fixed speaker side,
renderer viewport or detector into a reusable Track. A project's chosen dimensions and positions
are ordinary Source and Recipe decisions.

## Write the smallest component that expresses the role

Declare the new package in the project's `packages/` and ordinary package configuration. Read the
installed `@hypit/hypit/author-kit` README for the public package boundary and inspect a close installed sibling for
the relevant implementation, rather than depending on a monorepo example directory being present.
`@hypit/interview-emoji-reveal` demonstrates persistent Moment-driven state; `@hypit/ranking`
demonstrates reveal Windows and settled rows; `@hypit/media-track` demonstrates occupancy and Handoffs.

Ranking provides a complete example in the installed Distribution. Its `packages/ranking/README.md`
links the relevant files: `surface.ts` projects authored time, `fragment.ts` connects typed inputs,
`schedule.ts` computes reveal and settled spans, `render.ts` draws them, and
`packages/ranking-studio/src/index.ts` turns the same program into editor entities. Follow the part
that answers the current question. A new component may use fewer operations or different state.

The Surface exposes author intent and lowers its supported temporal forms through shared projection
helpers such as `createTemporalWindowProjection` and `createTemporalInstantProjection`. The Fragment
wires those projections, the shared Timeline/Canvas and authored values into the component's
Producers. The Producer consumes the resulting time and geometry and owns the visual/state behavior;
Studio consumes that published meaning for presentation and editing.

Wire supplied media, Script content and event references through Source. Expose other content or
treatment in Source or Recipe where the work needs those choices. A one-off component can own fixed
illustrative labels, dimensions and animation alongside its state and visual structure; its boundary
does not require every detail to become a parameter. [Component design](component-design.md#separate-responsibility-parameters-and-reuse)
explains that distinction. A new Caption family consumes the common Caption document and timing.

## Connect the implementation at its real boundaries

The useful pieces of a project package are:

| Piece | Responsibility |
| --- | --- |
| Manifest | Module identity, nominal Types, Producer input/output ports and dependencies |
| Surface | Validate authored attributes and children, resolve typed references, emit inert Records, Components and Fragments |
| Fragment | Wire the finite computation graph and publish outputs |
| Producer | Compute the immutable state or render program from declared inputs |
| Activation | Register the Manifest, deterministic handlers and Markup facets with their matching Host ABI |
| Vocabulary and preview | Explain the role and show a recognizable, configured example |
| Optional Studio Companion | Project meaningful editor entities, real parameter bindings and temporal lineage without changing video rendering |

Resolve the Track's `timeline` through `resolveTemporalContext` and wire `context.timeline.ref`
directly to its Timeline input. Words and source footage are available where prepared Takes provide
them. The visual Producer consumes Timeline and projected times, not Script syntax.

For each Window, call `createTemporalWindowProjection`; for an event, use
`createTemporalInstantProjection`. Pass the resolved context, the child element
and `resolveReference`. Preserve all returned `records`, `components` and `fragments`, and wire the
returned `ref` into the domain Fragment. The common `at` accepts a Moment or an authored duration
from program start. Selection and Segment boundaries use `boundary="start"` or `boundary="end"`.
A Moment needs the semantic context that locates its Script anchor.

Keep each child's `subjectId` meaningful to the component while qualifying graph ids by its owning
Track, so multiple instances can coexist. A finite create/append/finalize graph supports any authored
number of messages or cards with ordinary fixed Producer ports. The exact helpers and vocabulary
live in `@hypit/hypit/temporal-markup`; the `@example/chat-scene` package demonstrates authored and semantic events on one Timeline.

A scene may publish computed event times when another component needs them, just as it publishes a
Track. This shares pre-render data. When the author already specifies a common trigger, consumers
can share that input directly. Expose additional outputs for a real composition relationship.

For persistent state, reason about a requested frame directly. For example: outside the outer Window,
draw nothing; inside it, each slot shows its preset/activated answer or its placeholder. Apply an
entrance motion relative to that slot's activation frame. Deriving state directly from declared inputs
and the requested frame keeps Studio scrubbing and partial or concurrent rendering deterministic.

Emit the public VisualTrack representation through `@hypit/hypit/composition` and `@hypit/hypit/visual-ir`.
[Component visuals](component-visuals.md) explains Presents, element trees, local animation,
prepared surfaces and a complete drawing function. [Spatial layout](spatial.md) explains incoming
Frames, and [Fonts and text](fonts-and-text.md) explains font resources.
Pass asset references and exact font data through declared inputs. A visual Producer does not open
files, call GVI, run ffmpeg or choose a Provider. If an external preparation operation is needed,
represent it separately through its capability; its result becomes another input.

A component-owned sound can be a peer AudioTrack output; alternatively the Source can place a sound
on the same Moment. Neither choice requires a Track to inspect another Track's private state.
Document which Outputs are public, including useful deterministic program values for inspection.

## Verify the behavior the component introduced

When the new role needs its own timeline presentation or Inspector, read
[Companion authoring](studio-companions.md). Expose the domain
schedule and temporal identities at their actual boundaries so the editor consumes them directly
instead of reconstructing them from pixels.

Give the component a concise README, public vocabulary, a meaningful visual example and a preview
showing the state change. Verify the actual intended transition: an answer appears on its Moment,
previous answers persist, future ones remain hidden, and the whole strip respects its outer Window.
A designed still alone cannot establish that behavior. For stateful MG, a few meaningful frame
checks around activation and exit are more useful than snapshots of every implementation detail.
Also check a second instance, a differently sized Frame and direct seeking into the middle when
those exercise the new behavior.

## A reusable performance presentation

When the behavior presents existing Timeline footage, [Performance Styles](performance.md) offer
an occurrence model with broad and local Uses. A Style binds a typed fragment's additional inputs;
each Use supplies Timeline, Canvas and its original Window. The fragment exports a VisualTrack.
This supports project-owned HTML behavior and explicit extra events or material without introducing
a new Track protocol. A larger scene that coordinates footage and independent graphics can remain
its own component. Both paths use the same rendering capabilities.
