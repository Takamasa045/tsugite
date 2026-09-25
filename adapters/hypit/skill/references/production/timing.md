# Timing authored relationships

Read this when deciding when a component acts or what moving it in Studio should change.
[Script syntax](script-syntax.md) names speech relationships; [Timeline](timeline.md) places prepared
Takes and declares the complete work. This page owns the common author-facing time forms.
The consuming package's vocabulary declares which forms its Surface actually supports.

## Choose time from the relationship

For speech-led work, bind a reveal to the Moment it answers and a covering picture to the Selection
it explains. The accepted SemanticTake locates those identities in its media; Timeline placement
carries them into the whole work. Rewording or changing the performance can then preserve what the
picture follows. Reference timecodes document observations, not the new performance's timing.

Authored animation can instead place messages or state changes on a clock and give them an intended
reading rhythm. It needs no invented Script or media-backed Segment. A spoken Moment can also trigger
a component whose internal animation uses authored durations. The trigger, its offset and the length
of its response are separate decisions; one video can use all of them.

## Express an Instant or Window

Surfaces that expose Hypit's shared temporal vocabulary accept the forms appropriate to their role.
A Window occupies an interval:

| Form | Result |
| --- | --- |
| `during="program"` | The complete program Window. |
| `during={story.segment.hook}` | The Segment's Window. |
| `during={story.selection.proof}` | The Selection's Window, including its authored affinities. |
| `at={story.moment.claim} for="8f"` | A Window beginning at a Moment and lasting eight frames. |
| `at="2s" for="12f"` | A Window beginning two seconds into the film and lasting twelve frames. |
| `until={story.moment.claim} for="250ms"` | A 250 ms Window ending at a Moment. |
| `start="program.start" end="moment.cue" moment={story.moment.claim}` | A Window composed from two explicit endpoints. |

Each Window uses one complete form. Explicit endpoint expressions can use `program.start`,
`program.end`, `selection.start`, `selection.end`, `segment.start`, `segment.end`, or `moment.cue`,
with the corresponding semantic reference supplied alongside it. They can also use a clock position
such as `1.5s` or an offset such as `selection.start - 2f`. Frames and milliseconds are integers;
seconds may be fractional.

An Instant names one point:

| Form | Result |
| --- | --- |
| `at={story.moment.claim}` | The authored Moment. |
| `at="2s"` or `at="12f"` | A point on the film clock, in seconds or frames. |
| `at={story.selection.proof} boundary="start"` | The Selection's chosen boundary. |
| `at={story.segment.hook} boundary="end"` | The Segment's chosen boundary. |
| `instant="program.start + 8f"` | An explicit clock expression. |
| `instant="moment.cue + 12f" moment={story.moment.claim}` | Twelve frames after the Moment, following it when the delivery changes. |

`at="12f"` locates an event; `for="12f"` gives an interval its length. Frames use the selected
film clock. Semantic projection keeps the event's Script identity alongside its resolved frame,
so its authored relationship remains available for later changes.

A particular Surface may deliberately expose only some of these forms. Its vocabulary reports the
attributes it actually accepts; the shared spelling does not grant every component every temporal
behavior.

## Choose what a later edit changes

Dragging a direct Selection or Moment changes that identity in Script. Every Track consuming it
then follows the changed relation. The authored time form determines what the gesture changes:

| Time form | Timeline editing |
| --- | --- |
| `during={story.selection.proof}` | Move both boundaries by the same number of semantic stops; the duration can change. Trim either boundary independently. |
| `at={story.moment.reveal}` on an event | Move its Moment anchor. |
| `at={story.selection.proof} boundary="start"` or `boundary="end"` on an event | Move only that Selection boundary. |
| `at={story.moment.reveal} for="8f"` | Move the Moment, or trim the trailing edge to change the duration. |
| `until={story.moment.reveal} for="8f"` | Move the Moment, or trim the leading edge to change the duration. |
| `at="2s" for="8f"` | Move the clock position, or trim the trailing duration; `until/for` works conversely. |
| `instant="moment.cue"` or `instant="moment.cue + 2f"` with a bound Moment | Move the local offset while retaining the Moment; an omitted offset starts at zero. |
| `start="..." end="..."` | Trim one endpoint's time expression, or move both by the same frame delta. Referenced Script markers stay in place. |

A semantic stop is a distinct frame position occupied by word or structural boundaries. Select a
semantic marker to see its exact anchors; when several share a frame, the Inspector offers the
choices supported by its editable consumers. Word starts, word ends and structural boundaries
are all eligible anchors; a pause can belong to
either neighboring interval. Direct Segment/Program spans follow their structural boundaries
without timeline dragging. The executed time authority determines the available gestures, and
the Companion connects them to the component's entities and Source bindings.

Clock-based dragging writes the changed value or offset in whole frames at the current frame rate.
Unedited expressions retain their units: `2s` keeps its duration across frame-rate changes, while
`60f` keeps its frame count. Direct semantic dragging changes the Script anchors instead.

Script marker moves use the [same semantic affinities](script-syntax.md#bind-meaning-to-script-identities)
as authored markers. Writeback removes and inserts the moved markers while preserving unrelated
source whitespace, words, punctuation, pronunciation and display attributes. A shared Selection or Moment remains one relationship:
editing through any consumer updates its other consumers according to their own projections.

A component's Companion exposes the gestures it can write back to the authoring source.
[Studio](studio.md) explains the editing interface; [Track authoring](track-authoring.md) explains
using the shared temporal helpers in a project component. The installed `@hypit/temporal-markup`
package owns exact parsing, projection and write-target APIs.
