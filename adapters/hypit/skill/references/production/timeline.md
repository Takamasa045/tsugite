# Placing Takes on the Timeline

Use this when placing prepared Takes, leaving passages for MG, or creating a work without speech.
[Media preparation](media.md) produces local SemanticTakes; [Script and time](../creation/script-and-time.md)
owns Selection/Moment meaning, and [Tracks](tracks.md) explains presentation.

A Timeline contains the complete time range and the Takes placed within it. Semantic anchors exist
where those Takes supply them. For an event responding to speech, bind to its Selection or Moment;
use authored time for independently directed rhythm. Both belong to this one Timeline.
The project's reference `TIMELINE.md` records observations and their meaning; the production
`time:Timeline` declaration places the new work's material. Reference times locate evidence, while
production placements determine the rendered work.

```svml
<import as="time" from="@hypit/timeline-author@1"/>
<time:Clock id="clock" frame-rate="30"/>
<time:Timeline id="program" clock={clock} end="content.end+2s">
  <time:Take source={opening.take} at="2s"/>
  <time:Take source={explanation.take} at="previous.end+3s"/>
  <time:Take source={closing.take} at="previous.end-12f"/>
</time:Timeline>
```

First omitted `at` means zero; later omitted `at` means the preceding Take's end. Omitted Timeline
`end` means the latest end of all Takes. Ordinary sequential assembly therefore needs only the
Clock and Take references. Material lengths resolve when preparation finishes; generation can run
concurrently while these placement relations wait for their inputs.

`previous.end` refers to the preceding declaration. `content.end` is the maximum of all placed
ends, even when the latest-ending Take is not the last declaration. Absolute positions such as `20s`
work too. `end="30s"` reserves a fixed complete duration; `end="content.end+2s"` reserves a tail.
Reordering Take declarations changes placements that depend on `previous.end`, including omitted
`at` values, and can therefore move later dependent Takes.
Seconds, milliseconds and frames must resolve to exact frames on the Clock. All complete Takes fit
inside the authored extent. Take placement retains native speed and local semantic evidence.

A gap contains no performance source. A wordless Segment instead has actual prepared media, as with
someone dancing. MG can occupy either passage according to the intended picture. Pure MG needs no
placeholder media or Script:

```svml
<time:Timeline id="animation" clock={clock} end="30s"/>
```

The output `.timeline` supplies Film and component contexts through `timeline={program.timeline}`.
Component Surfaces, Fragments and Producers use that same Timeline; shared temporal helpers
project both literal times and Script references against it.
Timeline exports only `.timeline`. [Sound](sound.md) presents its existing audio and supplies an
AudioTrack to Film. Its ordinary Style chooses the last declared active audio source; a project
Style can explicitly mix sources. Material remains available independently of its presentation.

[Performance](performance.md) obtains existing footage from the Timeline. Ordinary Media Items take their own
assets. Caption obtains existing words, while Typography takes authored text. A custom scene can
consume the same placed footage and projected event times. New display Windows preserve the source
frame corresponding to the current Program time; moving a viewport does not restart playback.

Overlapping Takes make both sources available. They do not prescribe a dissolve or choose a picture.
Performance places its sampled layers in declaration order; for a coordinated blend or layout,
use a scene that owns that behavior. Simultaneous Caption Cues retain their spoken intervals; use
Role-based styles or separate Caption presentations when their placement should differ.

Caption also receives a Script-derived CaptionDocument: the document supplies display text and cue
structure, while Timeline supplies placed timing. Independent B-roll and music receive Timeline for
placement and their own assets for content; semantic preparation is needed for a performed Script,
not for every asset used in a composition.
