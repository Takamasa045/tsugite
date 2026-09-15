# Presenting existing sound

Use Sound to present audio from Takes already placed on the [Timeline](timeline.md). Use
[Audio Track](tracks.md#sound-text-and-caption-answer-different-events) for independently supplied
music and effects. Sound chooses how existing sources are heard; [Performance](performance.md)
chooses how their pictures appear. Neither changes the Script or the Take placements.

## Broad treatment and local Uses

```svml
<import as="sound" from="@hypit/sound@1"/>
<sound:Style id="normal"/>
<sound:Style id="opening" gain="0" end-gain="1"/>
<sound:Style id="silent" gain="0"/>
<sound:Track id="voice" timeline={program.timeline}>
  <sound:Use style={normal}/>
  <sound:Use at="0f" for="2s" style={opening}/>
  <sound:Use during={story.selection.demonstration} style={silent}/>
</sound:Track>
```

Select `voice.audio` in Film to hear this presentation. Timeline retains source material; Sound
chooses how it is heard. Independent music and effects remain separate Film contributions.

The first Use sets a broad treatment. The last matching Use replaces it locally, including when
the winner is silent. A later normal Use can restore sound inside a muted passage. No matching
Use means no sound from this Track. This is the same broad/local presentation rule as Performance
and Caption, with time Windows as Sound's domain.

The ordinary Style chooses the last Timeline-declared active source with audio. A Take without an
audio member contributes no candidate. No Take means no original sound; it does not affect separate
music or effects. A recording that contains silence is still an audio source.

`gain` is a linear amplitude multiplier, normally 1; `end-gain` defaults to the same value. Different
values create a linear change over the Use's full Window. Use `gain="0"` for silence, or
`gain="1" end-gain="0"` for a fade-out. A leading Timeline gap has no source to fade: attach an
opening fade to the first Take's actual start when it begins later than the program.

All shared time forms apply: `during`, `at` + `for`, `until` + `for`, and `start` + `end`. Word-related
changes can follow Selections or Moments; independently timed changes can use seconds or frames.
The Window governs treatment progress, while the Take placement governs source playback. After a
local override, both resume at the progress appropriate to the current time.

## Explicit source relationships

For a crossfade, a project Style selects its outgoing and incoming Segments explicitly. An ordinary
Use then selects the overlap Window. A Style declaration might look like:

```svml
<mix:Crossfade id="handoff"
  outgoing={story.segment.first} incoming={story.segment.second}/>
<sound:Track id="voice" timeline={program.timeline}>
  <sound:Use style={normal}/>
  <sound:Use style={handoff}
    start-source={story.segment.second} start="segment.start"
    end-source={story.segment.first} end="segment.end"/>
</sound:Track>
```

Here `mix:Crossfade` is a project-defined Style, not a built-in Sound tag. Its complete example ships
at `examples/semantic-composition/packages/sound-styles/` in the Hypit Distribution. The interval
locates the effect; the bound sources determine its roles. Sound does not infer a mix from a visual
transition. A family for intentional simultaneous speech can retain both sources at full gain.

## Author a new sound Style

Use `soundStyle(fragment, bindings)` from `@hypit/hypit/sound`. Its fragment receives `timeline` and
the original `window`, plus the family's typed bindings, and exports `audio: AudioTrack`. A Surface
publishes this definition as an inline `soundTypes.style` value. Each Use expands normal graph edges.

`sourceSound(timeline, window, segment, { gain, endGain })` selects one existing source, and
`ordinarySound(timeline, window, { gain, endGain })` provides the usual last-source behavior. Known
sources without audio return no clips. A custom family can combine explicit sources or author a
richer gain envelope using ordinary AudioClip data. No new renderer mode is needed.
See [component authoring](track-authoring.md) for packaging and [sound direction](../playbooks/craft/sound-mix.md)
for deciding what the audible change contributes to the work.
