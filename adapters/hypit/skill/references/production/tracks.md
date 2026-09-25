# Choosing and composing contributions

Read this to choose how content enters the picture or sound. [System](system.md) explains the
relationships; [media preparation](media.md), [Timing](timing.md) and [spatial layout](spatial.md)
own the shared inputs. A new shared behavior belongs in a [project component](component-design.md).

## Choose by content relationship

| Content relationship | Useful starting point | Published contribution |
| --- | --- | --- |
| Present footage already placed on Timeline | [Performance](performance.md) | `.visual` |
| Supply an independent image, prepared video or compositable surface | [Media](media-presentation.md) | `.visual`, optional `.audio` |
| Present audio already placed on Timeline | [Sound](sound.md) | `.audio` |
| Supply independent audio-bearing material | [Audio Track](audio-presentation.md) | `.audio` |
| Present Script's display words at their performed times | [Caption](caption-presentation.md) | Fine publishes `.track` |
| Supply a title, label or other independent writing | [Typography/Text](fonts-and-text.md) | Package-owned; Typography publishes `.track` |
| Coordinate content through a new layout, state or motion | [Project component](track-authoring.md) | Its declared VisualTrack and/or AudioTrack outputs |

The table routes common relationships; it does not define a closed list of visual roles. A board,
effect or whole scene is a component whose behavior owns its inputs and outputs. Images, text and
video can share one scene. Film receives their ordinary visual and audio contributions.

## Present a performance without reauthoring its playback

For pure A-roll as well as mixed work, place prepared SemanticTakes on the [Timeline](timeline.md),
then use Performance and Sound for the picture and audio the work needs. A broad Style can cover the
whole program; local Uses change its treatment. Caption independently joins Script display content
to that same timing. A performance need not remain visible to supply speech and semantic events.

An audio-only Take supplies no picture. A wordless performed Take can supply material and Segment
boundaries. A gap has no Take. These facts remain independent of graphics occupying that interval.
Independent material can also occupy the full canvas; size and transparency do not decide its role.

A new scene can consume `projectTimelineMedia` to keep placed footage at its current source frame
while coordinating it with other content. [Performance](performance.md) explains Styles;
[component visuals](component-visuals.md#compose-video-and-graphics-in-one-browser-program) explains
owning a larger scene. Media receives separately supplied material when that is the intended use.

## Let events and shared behavior determine organization

A Media picture can cover a Selection, a sound can follow a Moment, and a board can retain its answer
after a reveal. All use the same Timeline, with timing forms supported by their own Surfaces.
[Timing](timing.md) owns those forms; [Track authoring](track-authoring.md#keep-selection-projection-and-consumption-distinct)
owns implementing their projection and consumption.

An outer Window describes a component's lifetime. Internal events can have their own semantic
triggers, and the resulting state may persist. A scene's single lifetime does not justify moving all
its meaningful events to fixed percentages of that Window. Use the [component design principles](component-design.md#let-meaning-drive-the-behavior)
to separate event relationships from local animation.

Shared movement or state can justify a shared component. Independent contributions may stay peers
while consuming the same Moment. A Track is not required for each asset, each Script Segment or each
rectangle, and creating a component does not require publishing a package outside the project.

## Assemble the intended contributions

Film receives Canvas, Timeline and each selected visual/audio output. Timeline establishes the
complete extent; components establish appearances and their paint order. Include sibling audio
explicitly when wanted. A silent covering picture leaves the selected voice audible; selecting the
same voice through multiple audio contributions can duplicate it.

Film child order does not move a picture to the front. Each Present has its authored stacking and
its internal element tree. An internal transform, mask or transition can keep related content
together while independent Presents overlap it according to their own stacking.

[Rendering](rendering.md#assemble-the-picture-and-sound) shows assembly and full/range delivery.
[Review](review.md) judges the selected work, including performance, boundaries and the complete mix.
