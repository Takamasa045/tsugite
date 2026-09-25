# Present independent images, video and surfaces

Read this when explicitly supplying picture content and arranging its appearance or playback.
Use [Performance](performance.md) for footage and source positions already established by Timeline.
The distinction is content ownership, not whether the picture contains a person, covers the frame,
or has transparency. [Media preparation](media.md) owns the incoming values.

## Supply a source and its destination

With the named assets, Timeline, Canvas, Frames and Recipes declared:

```svml
<import as="media-track" from="@hypit/media-track@1"/>
<media-track:Track id="evidence" timeline={program.timeline} canvas={canvas}>
  <media-track:Item id="photo" image={product} extent={product-extent}
    frame={detail-frame} during={story.selection.example} appearance={look.media.still}/>
  <media-track:Item id="demo" media={demo-media.media}
    frame={detail-frame} during={story.selection.proof} appearance={look.media.clip}/>
</media-track:Track>
```

Each Item takes one direct source form: `image` with its actual `extent`, prepared `media`, or a
compositable `surface`. The current Surface takes no raw `video` attribute. Generated and file-backed
assets use the same inputs once they have the required Type. A still image needs no video conversion;
its Item supplies the display duration. Code-authored graphics can publish their own Track directly.

`frame` places the destination on the Canvas. `appearance` supplies fitting, clipping, decoration,
source sampling and required `stack-order`. [Spatial layout](spatial.md) explains fitting the source's
real extent into that Frame. Independent Items may overlap; a full-frame Item is also ordinary Media.

## Keep display time and source playback distinct

An Item's Window says when it is active. It can follow a Selection, Segment, Moment plus duration,
or an authored interval through the shared [time forms](timing.md). Its source sampling separately
says which frames to show. A semantic Window does not automatically inherit a Take's source offset.

For moving media, choose playback from the intended result:

| Intended behavior | Appearance `playback` |
| --- | --- |
| Play from the start at native speed, then expose the lower picture when exhausted | `once-start` (default) |
| Align native playback to the Window end | `once-end` |
| Hold the ending or beginning picture over excess time | `hold-start` / `hold-end` |
| Repeat at native speed with start/end alignment | `loop-start` / `loop-end` |
| Fit the selected source duration into the Window by retiming | `stretch` |

`trim-start` and `trim-end` select a pair of integer source-frame boundaries, with an exclusive end.
Omit both for the whole source. Under native playback, prepared media uses the Timeline's frame rate.
A shorter Window can truncate a longer clip; extending the Window does not extend the source.
Choose a hold, loop or retime only when that behavior serves the picture.

Durationless images reject playback and trim options. Their appearance Window is sufficient.
A surface's preparation supplies any frame information; its installed vocabulary describes the
applicable sampling. The `@hypit/media-track` README owns exact mode and boundary rules.

For example, independently replaying footage on a spoken claim can intentionally start that footage
from its beginning. Presenting the speaker continuously midway through a placed Take should instead
retain the Timeline source mapping through Performance or a project scene.

## Coordinate layers and replacements

An Item can declare ordered `Paint` and sampled `Layer` children instead of one direct source.
The Item owns the outer Frame, clip, border and motion; each sampled Layer has its own fit and
picture treatment. Use this when the parts make one framed unit. Separate Items own independent
placement. A richer scene can own further shared behavior in a [project component](component-design.md).

Use a Sequence when content replaces content in one visual slot:

```svml
<media-track:Track id="cards" timeline={program.timeline} canvas={canvas}>
  <media-track:Sequence id="steps" frame={card-frame} appearance={look.media.card}
    until={story.selection.demo} until-boundary="end">
    <media-track:Member id="first" image={first-image} extent={card-extent}
      at={story.moment.first}/>
    <media-track:Member id="second" image={second-image} extent={card-extent}
      at={story.moment.second}/>
    <media-track:Handoff id="replace" from="first" transition={look.transition.cards}/>
  </media-track:Sequence>
</media-track:Track>
```

Members have ordered activation Instants and the Sequence has a terminal Instant. Each adjacent
pair declares a Handoff, including a cut. `from` names the outgoing Member; the next Member is its
successor. Transition duration and boundary ratio shape the handoff around the logical event;
they do not relocate that event. The Sequence retains the shared outer geometry as its contents change.
Query the selected package for its exact Layer, Member, Sampling and Handoff forms.

## Move the presentation or sample the picture

A `motion` Recipe moves or fades the framed unit. `Sampling` children pan, zoom or rotate the fitted
picture inside that frame. A still can receive the same spatial sampling motion. [Spatial layout](spatial.md#move-the-frame-or-move-its-contents)
shows the distinction and an example.

A single Item's local motion may follow progress through its Window. When separate internal actions
answer separate lines, give them separate events or use a scene exposing those events. An outer
semantic Window alone cannot keep every internal action aligned with changed speech.

## Include sound deliberately

Source audio is opt-in: `source-audio="content"` selects the direct source, or a child Layer id selects
that Layer's sound. A `Sound` child can instead attach normalized audio to an Item's entrance/exit
or to a Sequence handoff. The Track publishes `.visual`, `.program`, and `.audio` when sound is present.
Film includes the desired outputs separately.

Source audio follows the selected sampling policy; holding a picture does not synthesize held sound.
An otherwise silent overlay leaves the Film's existing Sound contribution audible. Use
[Audio Track](audio-presentation.md) for independent sound placement and avoid routing the same voice twice.

When uninterrupted visual coverage matters, inspect semantic pause boundaries, source exhaustion
and transition opacity together. [B-roll](../playbooks/craft/b-roll.md) owns the editorial choice;
[review](review.md#make-the-composition-work) locates an unintended exposure in the actual picture.
