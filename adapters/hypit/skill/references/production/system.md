# How a Hypit production fits together

Read this for the relationships among material, meaning, time, space, presentation and execution.
[Production navigation](index.md) routes each current question to its detailed owner.

> Give semantics to the timeline, rather than the timeline to semantics.
>
> Give layers to the canvas, rather than the canvas to layers.

The work has a complete time range and a canvas. Attach events to their meaning in the performed
work; introduce component boundaries where content shares useful layout, state or motion. Semantic
coverage need not fill time, and visual components need not partition the canvas into fixed regions.
The author decides which relationships the work needs. Hypit expresses and realizes them.

## Materials acquire their roles through use

A supplied file, a generated Output and a reused Result can supply the same kind of material.
An image has dimensions; moving media has local time and selected picture/audio streams. Transparency
is a property of the prepared picture. A model reference, a performed passage and an independent
illustration are uses of material, not separate file classes.

For a work carried by performance, including a short drama or an otherwise pure A-roll piece,
prefer Script and semantic preparation. Script names meaningful, performable passages and events;
the accepted performance supplies their actual time. This remains useful without MG: replacing a
passage, revising dialogue, placing Caption or directing sound can preserve the same relationships.
A Segment need not equal one camera shot or one speaker turn.

In this spoken chain, A-roll is the performance carrying the Script passage. Its picture can fill
the frame, move, disappear beneath evidence, or be absent in an audio-only performance. That role
specifies neither a source aspect ratio nor a visual component type.

Material identity, performance role and current appearance answer different questions. One placed
performance can supply several simultaneous views; a later replay of its source can have independent
playback. Direct cuts and continuous movement are authored ways to change presentation. The Timeline
keeps the performance's time, while each visual owner determines its use on the Canvas. A layout
change can reuse the same accepted material and semantic evidence.

A **SemanticTake** combines one Segment's prepared media with its local word and boundary positions.
The current Timeline Take input is this value. Independent images, video inserts and music instead
enter the components that use them; they do not need artificial Script passages. A wordless performed
Segment has real media and its boundary times. A standalone material transformation can finish with
the transformed asset. [Media preparation](media.md) explains these input relationships.

## One Timeline provides the work's time

The **Timeline** holds the complete range and placed Takes. A Take's placement translates its local
positions into program time. Gaps, overlaps and a range with no Takes are valid. A code-authored ending
can extend past the last performance; a wholly authored animation uses the same Timeline.

For an event that responds to a word or passage, retain the Script Moment or Selection. The component's
Surface projects that reference through the actual Timeline to an Instant or Window. Independent
rhythm can use authored clock positions, and motion can have its own duration. These all use the
same program clock. [Timeline](timeline.md) owns placement; [Timing](timing.md) owns event expressions.

Placed content is available before any presentation is selected. Timeline chooses no winning
picture, transition or audible mix. An overlap supplies multiple sources; the presentation owns how
they appear or sound. Independent Media, graphics and audio also use this Timeline to place events,
including events attached to speech.

## One Canvas provides the work's space

The **Canvas** supplies picture dimensions and coordinates. A Frame locates a destination; fitting
maps a source's real extent into it. Components own their internal layout and motion. A presenter
and diagram can share a scene, while an independent title remains a peer. Frames may overlap, nest,
move or extend beyond the canvas.

Canvas is a geometry value, not a second asset store or a central layer tree. Each visual contribution
publishes its own appearances and internal trees. A **Present** owns an appearance's lifetime and
paint order; that order determines what covers what. [Spatial layout](spatial.md) owns geometry;
[component design](component-design.md) owns useful visual scope.

Time authority and visual scope are independent choices. One scene can follow several semantic
events; separate components can share one Moment. Giving a scene the whole canvas does not require
fixed-second choreography. Giving an image a semantic Window does not turn it into a Take.

## Present existing content or supply independent content

Two content relationships recur in ordinary authoring:

| Content | Present already authored content | Supply content for this contribution |
| --- | --- | --- |
| Picture | Performance obtains footage and source positions from Timeline. | Media receives images, prepared video or compositable surfaces. |
| Sound | Sound obtains placed audio from Timeline. | Audio Track receives independent audio-bearing material. |
| Text | Caption obtains Script display content and its performed timing. | Typography/Text receives independent writing. |

These are useful starting points. A project scene can combine placed footage, independent assets,
text and projected events when they share behavior. The same video can carry a performance here and
serve as an independent replay elsewhere. [Tracks](tracks.md) routes the actual presentation choices.

Performance, Sound and Caption separate available content, timed **Uses**, and the **Style** applied
by each Use. Later matching Uses replace the treatment locally; independent Tracks can coexist.
The content retains its original timing under these choices. Each family owns its rendering and
content-specific rules.

Keep three times distinct: program time locates the appearance, source time identifies the media
frame, and local animation time determines the presentation's state. A Take placed at second 5 is
at source second 2 at program second 7, even if its viewport only becomes visible then. Performance
and project scenes can consume this mapping directly. An independent Media Item instead declares
its own source and playback policy. [Performance](performance.md) explains continuous presentation.

An original and a cutout are explicit material choices. If the placed Take contains only the cutout
picture, a presentation needing its original background must receive the retained original as an
input. No Style can recover pixels absent from its material.

## Components express the relationship worth preserving

A component owns shared behavior. Its public inputs connect actual dependencies and useful directing
choices: selected assets, important events, placement or a treatment that the work needs to vary.
Decorative geometry and a fixed local design can remain in its implementation. A one-off scene is
ordinary production work; reuse and cross-project distribution are separate decisions.

Critical internal events need their own semantic relationships when they answer different parts of
the performance. Making only the scene's outer Window semantic does not keep several word-linked
actions synchronized. Interpolation and local motion can then follow those events without exposing
every number as a control. [Component design](component-design.md#let-meaning-drive-the-behavior)
explains that boundary; [Track authoring](track-authoring.md) explains the public implementation path.

Visual components publish VisualTracks; audible contributions publish AudioTracks. Film explicitly
selects the wanted contributions and combines them with Timeline and Canvas into a **Composition**.
Including picture does not include sibling sound automatically. A whole scene can publish both
outputs while keeping their assembly explicit. Source nesting, component scope, paint order and
execution dependencies describe different relationships and need not have matching boundaries.

## Give each part the direction it can realize

The Agent keeps the complete creative intention and translates it into each part's effective inputs.

| Recipient | Direction it can realize |
| --- | --- |
| Image generation | Visible appearance, setting, camera relationship, activity and reference facts. |
| Video generation | Dialogue, performance, physical interaction, camera behavior and intended cuts. |
| Voice generation | Wording, vocal character, delivery and suitable voice references. |
| Visual/audio components | Selected content, layout, events, treatments and mix. |

A planned diagram may call for a person framed on the right. Give the image request that visible
camera relationship; give the diagram component its placement and events. Translate later MG or
screen-writing needs into the picture facts the image model can produce. The full Treatment remains
the director's context. [Image direction](../playbooks/craft/image-direction.md),
[video direction](../playbooks/craft/video-direction.md), [voice direction](../playbooks/craft/voice-direction.md)
and [Prompt Kits](prompt-kits.md) own those local decisions and templates.

## Source describes the work; Run selects this execution

The Author Source connects content, media requests, components and deliverables. Recipes provide
authored values. A Run chooses public Outputs as **Targets** and can supply alternative **Candidates**,
such as a file or an exact earlier Result Output. The selected dependencies determine what executes.

For a layout revision, keeping a compatible SemanticTake preserves the performance and alignment
while the presentation recomputes. Keeping only its generated video lets normalization and alignment
recompute too. Keeping the old Composition would also preserve the old layout. Choose the reuse
boundary according to the current edit. [Authoring](authoring.md#reuse-produced-work-explicitly)
owns that judgment; [Runs](runs.md) owns the syntax.

A **Build** executes the selected work. Its **Result** retains completed public Outputs, including
usable products completed before a later failure. A new Build uses prior work only through explicit
selection. [Builds](builds.md) owns execution, recovery and retrieval.

## Runtime and Studio serve the authored work

External work is expressed as a Need. Model and processing packages define capabilities; Providers
implement them through Endpoints selected by a Runtime Profile. Tools, credentials and capacity belong
to those execution choices. [Environment](../environment/profile.md) owns setup; [rendering](rendering.md)
owns requesting an encoded output from the Composition.

Studio inspects the same selected Run. A package's Companion connects recognizable entities and
useful controls to their actual authored facts. Editing a shared Style or semantic event affects
its consumers; a local parameter changes its own owner. Studio does not require every internal
detail to become editable. [Studio](studio.md) explains use and writeback;
[Companion authoring](studio-companions.md) explains project integration.
