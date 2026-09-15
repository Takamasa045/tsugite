# How a Hypit production fits together

Read this for the relationships that connect authoring, media, composition and execution.

> Give semantics to the timeline, rather than the timeline to semantics.
>
> Give layers to the canvas, rather than the canvas to layers.

The work has a complete time range and a canvas. Add semantic attachments where events belong to
speech, and introduce component boundaries where they express useful shared behavior. A silent
ending can contain only graphics. A moving presenter and diagram can share one scene. Neither time
nor space needs to be completely partitioned by the same kind of object.

SVML expresses what belongs together in a video: which media carries a passage, which picture
supports an idea, and which words or events a Caption, graphic or sound follows. Those relationships
let the production survive revision. When a performance becomes longer, a graphic attached to the
same phrase can still appear with that phrase.

Treat components as vocabulary you can use and extend. A comparison, a scrolling conversation or a
presenter making room for a diagram can each have named content, events and behavior. Define the
parts that make this work understandable and useful to change. Existing Media, Caption and other
components can supply familiar behavior; a project component supplies a new role through the same
interfaces. [Component design](component-design.md) explains how to find those boundaries.

For spoken work, semantic authoring is the preferred starting point, including a clone.
Understand which idea, question, answer or action each layer serves. Express that relationship in
the target's Script and components, then project it through the new media. For example, a product
picture follows the explanation of its benefit and a graphic settles when the speaker gives the
verdict. The reference's seconds locate evidence; the target's actual performance supplies its time.

## Materials meet composition at the Timeline

```text
Script + directed or supplied material
                ↓ normalization and, for Script performance, semantic preparation
         prepared material with local time
                ↓ placement
     Timeline: full extent, Takes and semantic anchors
                ↓ selected content, event times and source playback positions
       components → Film → rendered video
```

Independent images, B-roll and music bring their own assets to their components. Caption also uses
the Script's display text. The Timeline supplies their common time context; a Frame supplies spatial
placement. The diagram describes relationships, not a serial production checklist: independent
material requests and component implementation can progress together.

Script names the work's Segments, words, Selections and Moments. A Segment identifies a passage;
a Selection identifies a range within the Script; a Moment identifies a point. The author can refer
to them before a performance has been generated.

Once the media exists, normalization gives it a shared frame clock. A **SemanticTake** associates
that media with one Script Segment and records its word and boundary positions in local frames.
The **Timeline** places prepared Takes within the complete work. Their global word and boundary
positions are local positions plus the Take's placement start. It can contain gaps or overlapping
Takes, or no Takes at all. A pure MG work uses this same declaration with an authored end.

[Timeline authoring](timeline.md) explains sequential defaults, relative and absolute placement,
head/tail space and the unified component input.

In spoken work, the performance carrying the main Script is the A-roll. A single presenter, a
conversation with several speakers, and an independent narration can each carry this spine.
Covering the speaker with B-roll does not change whose words establish time. Timeline assembly places
the relevant Takes and retains their source material. Performance or a project
component presents the placed picture; Sound presents the placed audio. Film explicitly selects
their contributions.
The speaker can occupy a small circular inset or appear as a cutout above a full-screen demonstration.
That speaking performance still supplies the SemanticTake. A-roll describes this semantic role;
screen area and stacking belong to its visual presentation.

This is how “show the proof while she explains the result” becomes a precise interval in the
produced video. A wordless Segment works through the same relationship: its media supplies the
span, with start and end boundaries and no spoken words to locate.
A gap instead reserves time without a Take. Use Timeline placement and extent for such passages;
their graphics can be authored directly.

[Script and semantic time](../creation/script-and-time.md) explains the authoring forms.
[Media preparation](media.md) explains normalization and constructing Takes.

## Components turn those relationships into picture and sound

Choose content ownership as well as presentation:

| Content relationship | Useful starting point |
| --- | --- |
| An independent image, video or surface with its own placement | Media |
| Existing Timeline footage shown full frame, inset, hidden or moving | Performance |
| Existing Timeline audio | Sound |
| Independently supplied music and effects | Audio Track |
| Independently authored text | Typography |
| Existing Script words presented at their performed times | Caption |
| A newly coordinated visual role with shared layout, state or motion | A project component |

These are useful abstractions to compose and extend. A custom Performance Style can direct footage;
a scene owning a presenter and diagram can expose their combined behavior. [Performance](performance.md)
and [component design](component-design.md) explain those choices. [Sound](sound.md) applies local
treatments to existing audio through the same Use model.

Content, Use and Style answer different questions: what is available, when a treatment applies,
and what that treatment does. Performance, Sound and Caption share timed Uses: a broad Use sets
the treatment, and later matching Uses replace it locally, including hidden or silent presentation.
The original source playback and word timing continue beneath those choices. Independent Tracks
can coexist when the work calls for simultaneous presentations. [Caption presentation](caption-presentation.md)
explains how complete Cues retain their content while their styling changes.

Choose each relationship at the scale that makes it useful. Script describes what an event follows;
Frames describe placement; a component owns shared layout, state and motion. The dependency graph
says which values that work needs. These structures can differ: a Source element can produce several
appearances, and one appearance can contain a whole scene of video and graphics.

A component gives an authored relationship its behavior. A ranking board can consume a phrase's
Selection to animate an entry; a reveal, flash and sound can share one Moment. Each interprets the
event according to its role. The board may keep the revealed answer visible after the entrance ends.

Where placement, appearance or content need external direction, a component can accept a Frame,
Style, text or images for those choices. This lets one behavior serve different uses. A one-off scene
can instead keep its specific design local while receiving the media and semantic events it needs.

Visual and audio components publish Tracks. A visual Track groups named appearances; each appearance
owns its lifetime, paint order and internal element tree. A moving video and its diagram can form
one scene, with independent Caption beside it. Media provides ordinary presentation, and a project
component can own the shared behavior of a more specific scene. [Component design](component-design.md)
explains that choice; [drawing a component](component-visuals.md) shows both structural elements and
HTML/CSS programs with frame-driven behavior.

The component's Surface can accept a Moment, Selection or direct time and use shared projection
helpers to provide the resulting Instant or Window to its behavior. The author expresses the
relationship in one place; the implementation handles its conversion to frames. When presenting
speech media, its playback mapping also identifies the right Take and source frame. Moving its
viewport can therefore leave the performance playing continuously.

A local HTML/CSS program can own the needed layout, state and motion while participating in the
same composition as ordinary Media and Caption. It does not need to become an intermediate video.
The scene's internal implementation can use further functions and parts without making each one a
separate Track. This lets an author expose the useful controls and implement the rest locally.

Film assembles the wanted Tracks into a **Composition**, and rendering turns that composition into
the delivered video. Including performance audio lets
it continue under B-roll; a silent covering picture changes only the visible layer.
A component coordinating graphics and sound can publish both contributions; Film selects each
explicitly. Their shared event can preserve synchronization without making audio inclusion implicit.

[Tracks](tracks.md) explains the available roles. [Spatial layout](spatial.md) and
[fonts and text](fonts-and-text.md) explain their shared inputs. A new role can be implemented as a
[project component](track-authoring.md) and included through the same composition model.

## Give each part the direction it can realize

The Agent connects the complete design to the responsibilities of its parts. Treatment retains the
creative reasoning; each production input expresses the choice its recipient should realize.

| Recipient | Useful direction |
| --- | --- |
| Image generation | The intended picture: appearance, style, camera relationship, visible activity, setting and reference facts. |
| Video generation | The performed passage: dialogue, attitude, audible and visible expression, actual interaction, camera behavior and cuts. |
| Voice generation | The intended vocal character and delivery, with the wording and references appropriate to that request. |
| Visual and audio components | The selected materials, content, layout, presentation, mix and authored events they should arrange. |

A planned graphic may affect where the camera places a person. Give the image request that camera
relationship and give the graphic component its own placement and events. This preserves the shared
design through different inputs rather than copying the whole Treatment into each request.

High-level language earns its place through the sensory or behavioral choices it communicates.
Preserve recognizable styling and performable attitudes; resolve an uncertain action or a figurative
idea into the output actually intended. [Image direction](../playbooks/craft/image-direction.md),
[video direction](../playbooks/craft/video-direction.md) and
[voice direction](../playbooks/craft/voice-direction.md) own those concrete judgments. The
[Prompt Kit](prompt-kits.md) preserves useful wording and assembles the chosen direction.

## Source describes the work; Run selects this execution

The Author Source connects the Script, media requests, components and deliverables. Recipes hold
reusable authored choices such as Styles or prompt configurations. The connections form a dependency
graph: completing the final video requires the values used to make it.
The author graph describes those dependencies; the run graph incorporates this execution's selected
Targets and Candidates. Visual grouping, paint order and execution dependency remain separate
relationships: one scene can require several material requests, while one material can supply
several appearances.

These graphs have different jobs. The Author Graph offers the work's public Outputs and their
default computations. The Run Graph supplies Targets and explicit alternative Candidates. Planning
applies those choices, follows the selected dependencies and freezes one execution definition for
the Build. Runtime advances that selected work; it does not reconsider Candidates or rediscover reuse.

A **Run** selects which public Outputs to complete through **Targets**, and can choose a different
**Candidate** for an Output. That Candidate might be a supplied file, a prior Result, or a computation
provided by a Run Fragment.

For a Caption revision, keep the existing SemanticTake and target the final video. The selected Take
already supplies the performance and its timing; the changed Caption and downstream rendering remain
work to do. This separates revising the video from repeating media generation. The Run records that
reuse explicitly.

Selecting only the generated video instead leaves normalization and semantic preparation downstream.
Selecting the Take keeps those prepared relationships too; selecting the final composition would
also keep its earlier layout. Choose the boundary that preserves the material without preserving the
thing being edited. A new named Output can reference existing bytes, including inside a composite
value; a new Build does not by itself mean new media or another stored copy.

A submitted execution is a **Build**. Its **Result** retains completed public Outputs for inspection,
delivery and future selection, including useful Outputs completed before a later failure.
Runtime maintains the running work; Result files keep its products available independently of that
process. If an attempt fails, a new Run can select those products for a new Build. When changing the
video, locate the owning choice—material direction, placement, presentation or execution selection—
and preserve the other relationships that still serve the work.

[Source syntax](source-syntax.md) explains declarations and references. [Runs](runs.md) explains
selection and substitutes. [Builds and Results](builds.md) explains submission and retrieval.

## Runtime supplies the execution facilities

Some computations arrange values; others require media tools or external services. The latter
produce a **Need** describing that work. A model package defines a request's meaning, and a Provider
implements the corresponding capability through an Endpoint. The Runtime Profile selects the
facilities, credentials and capacity used to execute it.

For example, the Source declares the composition and requested render interval; the local
HyperFrames Provider's configuration chooses its worker count. A production can keep its authored
relationships while using the execution setup selected for it.

[Runtime profiles](../environment/profile.md) explains those choices. [Rendering](rendering.md)
explains whole and partial video outputs. [Studio](studio.md) provides interactive inspection and
editing of the same authored work with its selected media.

In Studio, a component's Companion makes its authored choices recognizable and editable. Content
and Uses can occupy one Track with an internal Band; independent child objects can have their own
lanes. A Style can supply its own controls through a parameter Companion. Editing a Use changes its
application; editing a shared Style, Frame or Selection changes that shared source and its consumers.
[Companion authoring](studio-companions.md) explains how project components supply these views and
writeback relationships through the same public interfaces.
