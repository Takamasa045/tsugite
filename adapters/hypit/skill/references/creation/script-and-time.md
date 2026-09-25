# Script and semantic time

Read this when deciding the target wording, pronunciation, performable passages and the meanings
that picture and sound should follow. It also covers measured delivery and wordless passages.
[Script syntax](../production/script-syntax.md) owns the authoring forms;
[Timing](../production/timing.md) owns their projection into the work.

[Source syntax](../production/source-syntax.md) covers the surrounding imports, references, Recipes
and Runs; [Tracks](../production/tracks.md) covers the consumers of Script meaning.
[Timeline authoring](../production/timeline.md) places Takes, allows gaps and overlaps, and declares
the complete work, including pure MG with no Script.
[Media preparation](../production/media.md) explains connecting actual footage to a Segment, and
[Runs](../production/runs.md) explains targeting material and reusing produced Takes.

## Script is the target's sole verbal authority

`<script>` contains the words the target video will say. It contains no reference timecodes, media,
visual Style parameters, prompts, or provider decisions. Semantic word attributes such as
`useful{emphasis}` can identify a word's role for a Caption family. Brief may preserve required claims and Treatment may describe
the purpose of a passage, but the adopted wording appears in Source only once.

Choose Script structure from the thought being expressed and the performance carrying it:

- a **Segment** groups a performable passage around its thought, delivery and action; its accepted
  media can become one SemanticTake;
- a **Role Cue** assigns a spoken turn to a performer and carries that label into the model's dialogue;
- **Dual Text** gives one authored unit separate display and pronunciation text;
- `||` says that one on-screen **Caption Cue** hands off to the next after a complete Alignment Unit;
- a **word attribute** gives a Caption family an authored role on one displayed word;
- a **Selection** names the span of meaning an element serves, such as a demonstration covering an
  explanation or a comparison held through a claim;
- a **Moment** names an event such as an answer or verdict, where graphics, sound or effects can
  respond together. The component decides how the resulting state continues.

```svml
<script id="story">
  <hook>
    <HOST> @{claim!} I made the @{proof}<API | A P I> || work overnight.@{/proof}
  </hook>
</script>
```

Here the viewer reads `API` while the performance receives `A P I`. The pair is one indivisible
Alignment Unit. `||` ends one on-screen Caption Cue after that unit and lets the next Cue begin with
`work`; `proof` remains one semantic range, and `claim` is a semantic point that other layers can use.

A Cue is a timed block of displayed speech, not a line of text. Its Caption family and Recipe may
wrap that block over one or more lines, reveal or highlight its words, and give the block an entrance,
exit or handoff. Segment boundaries and Role turns already separate Cues. Caption Use windows can change a
Style midway through a Cue while preserving its content and original word times.
Use `||` when the same Segment, turn and Style still needs another deliberate reading handoff. The
[Caption craft](../playbooks/craft/captions.md#design-cue-rhythm-with-the-caption-system) owns how the
picture, language, family and Recipe shape that decision.

[Script syntax](../production/script-syntax.md) owns the exact forms, display/speech projections,
spacing, grouping and marker affinities. Use those forms to express the choices above.

## Write the intended pronunciation

Choose pronunciation while writing the Script. For coined names, unfamiliar brands and abbreviations
whose reading needs direction, use Dual Text to keep the intended display spelling and give the
performer a clear spoken form. Write that form as readable words, syllables or letter names in the
performed language. Familiar word sounds, phonetic respellings and homophones can make an unfamiliar
name's intended sound concrete while its display spelling stays intact. Keep ordinary spelling when
it already expresses the intended reading; an English name inside Chinese speech does not
automatically need a phonetic replacement. Choose the reading for this language and character,
retaining the user's chosen display spelling.

### Choose the sound the spelling should carry

These examples illustrate authored pronunciation choices, not generation results verified for every
model. The spoken column is the literal text supplied through `.speech` or inside `.dialogue`:

| Intended reading | Script fragment | Caption displays | Spoken text |
| --- | --- | --- | --- |
| Name the letter S | `<S\|ess>` | `S` | `ess` |
| Say each letter of CSS by name | `<CSS\|see ess ess>` | `CSS` | `see ess ess` |
| Spell out an abbreviation using separated letters | `<API\|A P I>` | `API` | `A P I` |
| Say SQL as the word “sequel” | `<SQL\|sequel>` | `SQL` | `sequel` |
| Give a coined name familiar syllables, when “zoo no” is the chosen reading | `<Zuno\|zoo no>` | `Zuno` | `zoo no` |
| Give a name a chosen Mandarin homophonic reading | `<Lumi\|露米>` | `Lumi` | `露米` |

Letter names, letter sounds and an acronym pronounced as a word are different choices. `ess` names
S; it does not ask for a sustained /s/ sound. Likewise, `sequel` chooses one reading of SQL; use the
intended letter names when the character should spell it out instead. Choose natural phrasing for
the whole expression rather than inserting artificial pauses between every letter or syllable.

Phonetic notation, including IPA, can guide a model that understands it. Script forwards the written
form literally; it does not interpret IPA or expose a phoneme-control API. The spoken projection also
feeds measurement and semantic preparation, so choose a representation usable by that production's
speech path. Any model-specific pronunciation feature belongs to that model's documented inputs.
Keep a reading aid such as `ess` on the spoken side; prose instructions such as “pronounce this as”
belong in performance direction when needed, not among the words the Script asks the character to say.

### Carry the chosen reading through the work

```svml
<script id="story">
  <opening>
    <HOST> This app connects through an <API | A P I>.
  </opening>
  <closing>
    <HOST> The same <API | A P I> works here too.
  </closing>
</script>
```

Each pair applies to that occurrence. Carry the chosen spoken form into every occurrence of the
name, including other Segments, so separately generated performances receive the same direction.
The right-hand wording reaches the model through the Segment's `.dialogue`; Caption keeps the
display spelling. Settle these readings before measuring the Script and requesting its performance.

The same distinction helps Chinese copy express numbers and names clearly. For example,
`今年<2026|二零二六>年` displays the year compactly while specifying how it is said;
`只要<¥19.9|十九块九>` chooses a conversational price reading. Choose the spoken form for this
sentence's meaning and delivery. Measuring the Segment with `--language zh` then uses that spoken
wording, including the syllables hidden behind its compact numeric display. Caption retains the
authored simplified or traditional characters; transcription supplies timing rather than rewriting
the displayed Script.

## Choose performable passages

Supply the Segment's `.dialogue` to the speaking prompt; it includes Role labels and the chosen
pronunciation. `.speech` supplies pronunciation without Role labels for measurement or speech-only
requests. The Caption view preserves the display wording. These are projections of one Script,
so revising the words does not require maintaining another copy in a prompt or subtitle file.
[Script projections](../production/script-syntax.md#use-the-scripts-deliberate-projections) shows the
references and a two-speaker example.

Script also represents passages without speech:

```svml
<script id="story">
  <empty></empty>
</script>
```

`empty` is an ordinary Segment name; a name such as `product-detail` can express the passage's role.
No words does not mean no semantics: the Segment retains its identity and start/end anchors. Its
associated normalized media determines the duration, and its SemanticTake has an empty word array.
The same Timeline and Track timing vocabulary apply to a wordless passage or an entire
piece made from prepared media. The empty tag itself declares neither a zero-length interval nor a duration.
For an interval made only of component animation, use Timeline placement and extent instead; it
needs no media-backed Segment. Spoken, wordless-media and graphics-only passages can share one work.

Choose Segment boundaries from natural production passages and delivery length, not from every
picture cut. One Segment and Take can carry several speaking turns, camera cuts or a split-screen
conversation. One continuous narration can carry many B-roll changes through Selections. Edited UGC
can deliberately use several Takes driven by the same character-and-scene image; a natural cut is
often part of its appeal. A Role change or `||` does not require another generation.
When retained recorded speech carries the passage, a file cut changes that performed material but
does not automatically create a Segment. Several retained stretches can form one passage; distinct
passages can use separate Takes. Write the Script for the final performed words and align the
prepared result on its own local clock.

## Time an authored animation

For speech-led work, a graphic's timing usually follows what it explains. Preserve that relationship
in Script: a reveal belongs to its Moment, and coverage belongs to its Selection. Rewriting the
argument or changing the performance then carries the design into the target's actual timing.
Reference seconds document what you observed; the target Script expresses what the new graphic follows.

A chat animation, diagram or kinetic-text piece can instead be drawn entirely by components. Its
messages and changes still carry meaning; the author chooses when the audience receives them and
how long they need to read. Keep content and event timing together in the owning component's Source.
An event can have an identity such as `question` or `reveal` and an authored `at="2.6s"` without
inventing spoken words or a media-backed Segment. Film time is declared through a Timeline with an explicit end and zero Takes;
[composition and rendering](../production/rendering.md#compose-an-authored-animation) shows the form.

Choose timing per relationship, not once for the whole video. A spoken Moment can introduce a chat
scene whose messages then unfold at authored intervals. Conversely, an authored animation can reveal
one item on a spoken Moment. A projected expression such as `instant="moment.cue + 12f"` with
`moment={story.moment.intro}` keeps an interval relative to that spoken event. The event's trigger
and its entrance duration are different choices:
`at={story.moment.answer}` locates the answer; ten frames can give its arrival a particular character.

## Measure before choosing durations

For a new or revised A-roll performance, choose time from the target's words, delivery, and action.
The reference timeline remains useful for understanding rhythm and relationships; the new performance
establishes their actual timing. Even unchanged words may take a different amount of time with a new
speaker or delivery.

`hypit measure` is the creation-time command for `@hypit/estimate`. It counts pronunciation units and
estimates how many seconds they need at the chosen language and pace, using local computation:

```bash
hypit measure path/to/source.svml --segment opening --language en --pace normal
hypit measure --text "You expect me to type every coffee?" --language en --pace normal --rounding ceil
hypit measure path/to/source.svml --segment opening --language zh --pace fast --rounding round
```

Choose `--pace slow|normal|fast` from the intended delivery: conversational explanation may suit
`normal`, while brisk, tightly cut social delivery often suits `fast`. The CLI prints the actual
units-per-second rate; `--rate` lets you choose it directly. Mandarin counts Han characters as
approximate syllables and embedded English by syllable; English counts syllables rather than words.
Set `--language zh` for Chinese copy, including copy with English product names, and measure the
pronunciation side of Dual Text with `--segment`.

The density includes ordinary phrasing pauses. `--padding` reserves additional time for an intended
reaction, demonstration or held pause. Keep related performances at a coherent delivery density. Initial
estimates can retain fractions with `--rounding none`. `ceil` rounds upward to a whole second, while
`round` chooses the nearest one. Most video requests use whole seconds; choose the final literal with
the selected model's supported values and the intended performance in mind.

An energetic performance can still give a dense explanation room to breathe. Use the reference's
pronunciation-unit count over its spoken passages to inform a candidate rate, then choose for the target's language,
terminology and actions. Inspect the effective density after rounding each request: fitting every
line into the shortest supported duration can make the whole delivery rushed. Keep the chosen rate
and meaningful padding with the production's direction so later Segments follow the same decision.

Let that estimate inform the shape of the passage. A short line may belong with the next response,
benefit from a little fuller wording, or leave room for a meaningful action. A long passage may read
better with tighter copy or a split at a natural change of thought. Preserve the intended meaning and
energy while finding a performable shape, then measure the affected wording again. The
[Generated video direction](../playbooks/craft/video-direction.md#size-the-request-around-the-delivery)
applies this judgment to the selected model's request range.

Measurement balances the intended speaking density and sizes generation; it supplies no timeline
anchors. Once a Take is accepted, normalize it, align its actual speech to its Script Segment, and
assemble the resulting SemanticTakes into the Timeline. The literal duration answers how much
media to request. The aligned words answer where Caption, B-roll, MG, and Effects belong in that actual
media. Alignment measures real word positions inside that media envelope; it does not reproduce an
estimated distribution of words.

For a wordless Segment, choose the requested duration from the action, music or visual rhythm.
Speech-rate measurement has no role there; the resulting media still determines its Segment span.

## Bind meaning to Script identities

For a picture, Caption treatment, MG state, sound, or effect that belongs to spoken meaning, author a
Selection or Moment and use the consuming component's Surface to project it through the Timeline.
Use explicit seconds for genuinely clock-based or speechless design.

Choose an anchor by the event it names, including which side owns a pause. For adjacent B-roll,
one Selection can end where the next begins; for a held reaction, a range can include the silence
before the next word. [Marker affinities](../production/script-syntax.md#bind-meaning-to-script-identities)
express these choices through word and structural boundaries. [Timing](../production/timing.md)
explains projecting those identities into a component's Instant or Window, adding deliberate offsets,
and what a later Studio edit changes.

Reference archives keep original seconds and explain which original words or content events an item
serves. The target Source names the intended relation against the target Script. After the target's
actual audio is aligned, the Timeline supplies its frames. Do not copy a reference timestamp into
the target or preserve an incidental lead/lag unless that offset itself is part of the design.

## Connect reference understanding to audiovisual composition

Timing seen in Studio or a real Result may expose one of several different problems. A wrong Cue or
semantic anchor changes Script. A sound performance that changes the intended rhythm may change the
duration choice or Treatment. A correct Selection rendered badly changes the component or Recipe. An
unusable generated Take changes its prompt, reference, Candidate, or shot design. Put each correction
where its fact is owned.
