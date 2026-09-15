# Composing Tracks

Read this when putting performance, coverage, graphics, text and sound together. For a new component's
implementation, read [Track authoring](track-authoring.md); for a new Caption family, read
[Caption authoring](caption-authoring.md).

[Media preparation](media.md) explains incoming files, normalized media and SemanticTakes;
[spatial layout](spatial.md) explains placement, and [rendering](rendering.md) explains the deliverable.

## Choose by the contribution's job

| Role | Owns | Common published values |
| --- | --- | --- |
| Timeline | Complete time range and placed Takes, with any semantic evidence; it draws nothing | `.timeline` |
| Performance | Existing Timeline footage, with broad and local presentation Uses | `.visual` |
| Media Track | Independently supplied images, prepared moving media, or authored surfaces; B-roll is one use | `.program`, `.visual`, optional `.audio` |
| Sound | Existing Timeline audio, with broad and local presentation Uses | `.audio` |
| Audio Track | Independently timed music, ambience and effects | `.program`, `.audio` |
| Caption | Script-derived display text presented with speech | Fine publishes `.schedule`, `.track` |
| Typography / Text | Titles, labels and other independently authored text | `.program`, `.track` |
| Semantic MG | A board, comparison, reveal or another system responding to meaning | Package-owned; often `.program` and a visual Track |
| Effect | A treatment such as a flash over an authored interval | Package-owned visual output |

These are authoring roles. Film receives ordinary peer VisualTrack and AudioTrack values; it has no
special rule for a podcast, ranking or B-roll. A component can publish both picture and sound.

## Follow Selection → Surface projection → component consumption

Script publishes a Selection, Moment or Segment as a semantic identity. It carries authored Anchor
identities, not a Window, Instant, second or frame number. A component that wants to use that meaning
exposes an appropriate projection form on its own Surface:

```svml
<media-track:Item image={portrait.image} extent={portrait-extent}
  frame={layout.full} during={story.selection.example} appearance={look.still}/>
```

Here `during` belongs to `media-track:Item`. While lowering that element, Media Track's Surface
resolves the Selection and Timeline, creates the temporal projection Records and Fragment, and
wires the projected `Window` into Media Track's own Fragment. The projection subgraph resolves the
Selection's start and end Anchors against the selected Timeline and composes the resulting
Instants into that Window.

The Media Track's internal Producers consume the Window together with the media, Frame and authored
specification. Only there do occupancy, playback and motion acquire their component-specific meaning.
The internal Producers receive the projected Window, not the Script Selection, and do not search
Script words themselves.

The same chain supports different semantics without a central timing dispatcher. A graphic Surface
may project a Moment to an Instant and consume it as a persistent state change; an Audio Surface may
project a Selection to a Window and consume it as a Clip interval. A component may expose only the
projection forms its behavior can honestly consume.

```text
Script Selection / Moment / Segment
                 ↓ component Surface projection through Timeline
           Window / Instant
                 ↓ component Fragment and Producers
       occupancy, playback, state, sound or visual behavior
```

A render-range request is farther downstream: it chooses which already-authored output frames to
inspect or deliver and changes none of these relationships. [Script and time](../creation/script-and-time.md)
owns Selection, Moment and shared projection spellings; each selected Surface's vocabulary says which
forms that component exposes.

## Place prepared Takes on the Timeline

Each SemanticTake holds local prepared media and the Script Segment's local word/boundary positions.
[Timeline authoring](timeline.md) places those Takes: sequentially by default, or with authored
starts that leave gaps or overlap. The complete Timeline can extend before and after all Takes.
A wholly authored animation uses the same Timeline with zero Takes and an explicit end.

Caption, MG, Media, Typography, Audio and Effects share `timeline={program.timeline}`. Word-related
events retain Selection/Moment bindings; independent events can use authored positions. Source
overlap provides simultaneous content. Its visible presentation or crossfade belongs to the visual
component, not assembly. Original audio follows the same placements and remains silent in gaps.

For the usual spoken production, the performance carrying each Segment is the A-roll. In a podcast,
the participants' turns belong to that shared performance timeline; each visible speaker does not
create a separate program clock. Audio-only A-roll can also carry one Segment when that passage is
independent-narration-led. Music, sound effects and covering footage then follow the
assembled work. [Voice and performance](../playbooks/craft/voice-and-performance.md) owns the choice
between visible A-roll, covered visible A-roll and audio-only A-roll.

A-roll can be a circular presenter inset or a moving cutout over a demonstration. Its role is
semantic: it carries the Script. Timeline assembly places its prepared material and semantic evidence; Performance and Sound
independently decide how its pictures and audio are presented.

```svml
<time:Clock id="clock" frame-rate="30"/>
<time:Timeline id="speech" clock={clock}>
  <time:Take source={opening-take}/>
  <time:Take source={answer-take}/>
</time:Timeline>
<sound:Style id="voice-style"/>
<sound:Track id="voice" timeline={speech.timeline}>
  <sound:Use style={voice-style}/>
</sound:Track>
<performance:Style id="performance-style" frame={layout.full} appearance={look.performance}/>
  <performance:Track id="performance" timeline={speech.timeline} canvas={canvas}>
    <performance:Use style={performance-style} during="program"/>
  </performance:Track>
```

The imports, Canvas, Frame, Recipe and prepared SemanticTakes exist in this excerpt. The Media
Recipe specifies `stack-order`, fitting and frame presentation. Select `performance.visual` and
`voice.audio` from the Sound Track in Film. The material is generated once and remains the same performance.

[Performance](performance.md) owns broad and local presentation Uses. Its Timeline supplies source
positions; an interval from program seconds 7 to 10 samples source seconds 2 to 5 when that Take
starts at second 5. Ordinary Styles reuse Media geometry and appearance; project Styles can define
movement and mixing. Media Items retain independent playback and source trim.

A moving performance viewport and its neighboring diagram may belong in one component because they
share a layout change. That component consumes prepared material and projected Moments or Windows,
then draws their shared state. Independent Caption and coverage remain separate when useful.
Its Surface can expose a Scene, Item or another useful authoring unit. Inside the component,
`projectTimelineMedia` supplies the intersecting prepared Takes, their program spans and their source
offsets, so changing the layout preserves playback alignment.
[Component design](component-design.md) explains where to draw these boundaries;
[drawing a component](component-visuals.md#compose-video-and-graphics-in-one-browser-program) explains
HTML, CSS and frame-driven code inside one visual contribution.

Semantic structure also supports a wordless passage. It has no speaking A-roll, yet a named empty
Script Segment receives its actual boundaries from prepared media and remains addressable through
the assembled Timeline. Semantic identity here means that the work can refer to the passage and
its boundaries; it does not classify the passage or require spoken words.
[Media preparation](media.md#empty-segments-use-their-media-boundaries) owns that construction.

Every Take contributes its placed Segment boundaries to the Timeline. When its prepared
media has no audio stream, Sound has no audio candidate from that Take. A visual consumer skips
the missing source picture of an audio-only Take while its time and speech remain available.

## Coverage has a Window and a separate playback choice

```svml
<media-track:Track id="coverage" timeline={speech.timeline} canvas={canvas}>
  <media-track:Item image={portrait.image} extent={portrait-extent}
    frame={layout.full} during={story.selection.example} appearance={look.still}/>
  <media-track:Item media={prepared-broll.media}
    frame={layout.full} during={story.selection.proof} appearance={look.clip}/>
</media-track:Track>
```

An image needs its intrinsic Extent. Moving media enters through explicit normalization as `media`;
`surface` accepts an already compositable surface from another component. Frame says where it goes;
fit/crop says how the source occupies it.

[Spatial layout](spatial.md#fit-the-source-into-the-frame) explains the shared destination/content
model, including alignment, rounded corners, padding, borders and the difference between moving
the Frame and moving its contents. A Media Item or Sequence takes its outer Frame from `frame` and
its stack order from the appearance Recipe's `stack-order`.

For a picture with a designed backing, an Item can use ordered `Paint` and `Layer` children in place
of a direct source. Paint fills the frame; each sampled Layer has its own fit and picture styling.
The unit owns the shared clip, border and motion. A Sequence keeps that outer presentation while its
Members replace the content. Use separate Items when pictures need independent Frames. The Media
Track vocabulary supplies the exact Layer, Sampling and Handoff forms.

For natural moving B-roll, start with `once-start`: a short Window truncates the clip; a long Window
returns to the layer below after the clip finishes. If uninterrupted coverage matters, choose its
media and boundaries from the actual clip length. `hold-start` freezes a tail; choose it when that
stillness is intended. `stretch` retimes. A still occupies its Window without a video playback mode.
`@hypit/media-track` owns the precise sampling rules.

Independent Items can overlap. A Sequence instead owns one succession of Members and their pairwise
Handoffs. Use it when a replacement relationship or transition belongs to the same visual slot.
Touching Script Selections require matching affinity when an inter-word pause should remain covered;
also check source exhaustion and transition opacity. [B-roll](../playbooks/craft/b-roll.md) explains
the editorial choices and [frame coverage](../playbooks/craft/frame-coverage.md) explains boundary failures.

Media source audio is opt-in. Include the Track's audio output in Film when wanted, and avoid routing
the same speech twice. A silent covering image does not mute the performance below it.

## Sound, text and Caption answer different events

[Sound](sound.md) presents audio already placed on the Timeline, including local silence, gain
changes and explicit source blends. Audio Track supplies independent sources.

An Audio Item takes normalized audio-bearing media. `gain` is a linear multiplier; fades and trim
are explicit. Normalizing input media does not automatically balance or duck the complete mix.
Like Media Track, Audio Track places independent Items and accepts the shared timing forms.
Its `.audio` output connects to Film. Overlapping Audio Items mix; visual Items compose by draw
order. An explicit Item `id` gives Studio a recognizable name; unnamed Items display their source
reference while retaining independent timing and editing identities.

```svml
<audio:Track id="effects" timeline={speech.timeline}>
  <audio:Item source={reveal-sound.media} at={story.moment.reveal} for="600ms"
    playback="once" gain="0.45" fade-in="0f" fade-out="3f"/>
</audio:Track>
```

Use one Moment for an MG reveal, a sound and a flash when they express one event. A Window consumer
needs a duration; an MG state transition may only need the Instant. Explicit clock placement remains
valid for events independent of speech even in a speaking video.

Typography uses exact fonts, its own Style and Point/Area/Path placement. Graph Text and rich inline
content are alternatives. A rich Span Style replaces that run's typography rather than cascading
CSS properties. A headline held over several sentences is generally Typography. Caption instead
joins `story.caption` to `speech.timeline`; timed Uses choose presentation while authored `||`
breaks retain Script as the content-grouping owner.

[Fonts and text](fonts-and-text.md) covers exact faces, fallbacks, Emoji and Typography placement.

## Fine Caption and new Caption families

`@hypit/caption-fine` is the usual fine-grained Caption renderer. Its Recipe exposes placement,
font and size, glyph and box Paint, wrapping, active-word coloring, Cue and token motion, lead/tail
and handoff. Script supplies display wording, Roles and `||` Cue breaks; `@hypit/caption` joins that document to the actual semantic timing. Fine publishes a visible `.schedule`
and a rendered `.track`.

Use those controls for the appearance and rhythm they express. When the design needs a different
structure—such as a keyword on its own oversized line beside a supporting phrase—create a project
Caption family. It reuses the common document, Style applications and timing while owning its new
schedule and layout. [Caption authoring](caption-authoring.md) explains that extension. A new family
can be chosen directly for a new visual role; making one is ordinary production work.

For the selected family's exact attributes and Recipes, use `hypit vocabulary @hypit/caption-fine`
and its installed README. [Caption craft](../playbooks/craft/captions.md) explains reading rhythm;
[Caption styling and coverage](caption-presentation.md) explains timed Uses, Role filters, mid-Cue Style changes and hiding;
[Caption tracking](../playbooks/craft/caption-tracking.md) explains measured moving placement.

## Persistent MG is more than another timed image

A ranking board can remain visible throughout the program while one Selection controls a row's
entrance and settled state. An answer strip can start with a preset answer and reveal later slots
on Moments. Ending an activation does not necessarily remove the result. Read that component's
consumption rules, including preset state, event order and outer lifetime.

Keep the event in Script, the authored layout and palette in Source/Recipe, and the reusable state
behavior in the component. The same Moment can be used by several components without one reaching
inside another. Their outputs remain ordinary peers.

Ranking is a useful implementation reference: its outer Window keeps the board visible, each
Selection stages a reveal, and the resulting placement can persist. Its TopThree form uses
activation Instants instead. Read the installed `packages/ranking/README.md` for its forms and the
path from authored markers to schedule, drawing and Studio Companion. [Track authoring](track-authoring.md)
uses that same separation when designing a new semantic component.

## Assemble the intended peers

Film's domain assembly receives a Canvas, a Timeline and a Film Recipe. The current `film:Film`
Surface takes `canvas`, `appearance` and `timeline={program.timeline}`. Its Timeline supplies the
complete range and any semantic evidence. Pure MG can consist entirely of visual
components. [Rendering](rendering.md#compose-an-authored-animation) shows the complete time setup.
Include each desired visual and audio
output explicitly. Listing a Track later does not move it to the front: absolute stacking is authored
inside the Track's Presents. Use intentional, distinguishable layer orders where things overlap.

Canvas geometry and Program time are separate. Keep an inset's intrinsic extent, destination Frame,
crop and any measured regions in the same explicit coordinate relationship. Changing final crop or
framing can invalidate head-tracking placement even when timestamps remain unchanged.

Read the selected package's vocabulary for exact ports rather than treating every Track as one
universal interface. Inspect the dense frame, the state-changing beat, source endings and the
complete mix when reviewing the configured work.

[Composition and rendering](rendering.md) shows Film, the final video Surface and frame-range requests.
