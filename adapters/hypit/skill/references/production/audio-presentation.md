# Place independent sound

Read this when supplying music, ambience, narration or effects independently of placed Takes.
[Sound](sound.md) presents audio already on the Timeline. If a narration performs the work's Script,
prefer an audio-only SemanticTake and Sound so its words establish reusable semantic time.
An independent audio contribution can still follow that same Script's events.

## Prepare and place the source

With the source, Clock, Script and Timeline already declared:

```svml
<import as="pipeline" from="@hypit/media-pipeline@1"/>
<import as="audio" from="@hypit/audio-track@1"/>
<pipeline:Normalize id="hit-media" source={hit-source} clock={clock}
  video="none" audio="default" span-authority="audio"/>
<audio:Track id="effects" timeline={program.timeline}>
  <audio:Item id="reveal-hit" source={hit-media.media}
    at={story.moment.reveal} for="600ms" playback="once"
    gain="0.45" fade-in="0f" fade-out="3f"/>
</audio:Track>
```

An Item consumes normalized audio-bearing media and a projected Window. Music can occupy a Segment
or the program; effects can follow Moments. Shared [time forms](timing.md) also allow independent
clock events. The Track publishes `.program` and `.audio`; select `.audio` in Film to hear it.
An explicit Item id gives Studio a useful name. Two Items using one source remain two placements.

## Choose source playback and mix

`trim-start` and `trim-end` are source durations in frames, milliseconds or seconds; the end is
exclusive. For example, `1s` to `3s` selects those two source seconds. This differs from Media Track's
integer frame trim properties. Destination time remains the Item's Window.

- `once` / `once-start` plays from the Window start; `once-end` aligns native playback to its end.
- `loop` / `loop-start` and `loop-end` repeat with the selected alignment.
- `stretch` retimes with pitch preserved and requires explicit `min-rate` and `max-rate` bounds.

Playback expresses the intended occupancy. A long Window does not automatically loop or stretch
a short source. The installed `@hypit/audio-track` README owns exact behavior and rate constraints.

`gain` is a linear multiplier, defaulting to 1; fade durations default to `0f`. Normalization preserves
source level. Overlapping Audio Items mix; overlapping visual Items instead compose by paint order.
Balance music, speech, ambience and effects in the actual Film. [Sound direction](../playbooks/craft/sound-mix.md)
owns the audible judgment, including ducking and continuity.

A sound can share a semantic Moment with a reveal while remaining a separate contribution. If a
visual component owns a coupled sound, it can publish a peer AudioTrack output; Film still selects
that sound explicitly. Neither route requires reading another component's private state.
