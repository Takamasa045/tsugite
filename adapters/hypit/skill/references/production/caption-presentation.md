# Caption presentation

Read this to apply subtitle treatments, change them during a passage, or hide them temporarily.
[Caption craft](../playbooks/craft/captions.md) owns visual direction;
[Caption authoring](caption-authoring.md) explains creating a new family.

**Script organizes content; Use organizes presentation in time.** `||` determines which words belong
together. The Track joins `document={story.caption}` to the placed `timeline`, preserving displayed
text and pronunciation associations. Each Use selects a complete Style inside a time window.

```svml
<caption:Hidden id="hidden"/>
<caption-fine:Track id="captions" document={story.caption} timeline={film.timeline}>
  <caption-fine:Use style={base-style}/>
  <caption-fine:Use role="GUEST" style={guest-style}/>
  <caption-fine:Use during={story.selection.answer} style={answer-style}/>
  <caption-fine:Use during={story.selection.demonstration} style={hidden}/>
  <caption-fine:Use at={story.moment.key} for="2s" style={impact-style}/>
</caption-fine:Track>
```

Styles are declared by the chosen family. Fine Styles take a Recipe and exact fonts. A new structural
caption can use a project family with its own layout and behavior.

## One time language

| Intent | Use |
| --- | --- |
| A treatment across the whole Timeline | `style={base}` with no time attributes |
| Follow a semantic passage | `during={story.selection.answer}` |
| Follow a placed Segment | `during={story.segment.answer}` |
| Start at a meaningful word, for a fixed duration | `at={story.moment.key} for="2s"` |
| End at a meaningful event | `until={story.moment.key} for="12f"` |
| Explicit window | `start="8s" end="10s"` |
| A particular speaker | Add `role="GUEST"` to any of these |

[Performance timing](performance.md) explains the shared expressions and semantic references.
Use semantic boundaries when the treatment follows what is being said. Absolute times remain useful
for an explicitly timed presentation. A Role filters whose content is presented, independently of the
window: it can cover several turns and does not change the Window shown in Studio.

The last matching Use in Source order wins locally. Each match replaces the whole Style; properties
are not merged. A hidden Use clears this Track's subtitle presentation throughout that window,
including neighboring Cue lead/tail. Later Uses can restore a smaller interval. Audio and content
stay unchanged. With no matching Use, nothing is drawn. With no subtitle content, a Use has nothing
to draw. Independent Caption Tracks can intentionally show multiple presentations at the same time.

## A style change can happen inside a Cue

```text
test1 || test2 @select test3 || test4 @/select
```

This contains three Cues: `test1`, `test2 test3`, and `test4`. The Selection starts before `test3`;
it does not split `test2 test3`. With a broad ordinary Use and a later emphasized Use during `select`,
the complete second Cue changes Style at that boundary, then the third Cue uses the same emphasis.

Word times remain the original times. Karaoke or text reveal therefore continues at the appropriate
word when the Style changes or returns after a hidden interval. The Window limits visibility; it does
not restart the Cue's animation clock. Changing only one word's visual role is a different design
choice: Fine provides current/trail unit emphasis, while a custom family can interpret authored word
attributes for structural layouts. Display/pronunciation units remain complete.

In Studio, the content row shows Cues and the Uses row shows authored windows. Select a Use to edit
its time or referenced Style. Moving the Use does not move `||`. Inspect the resulting placement,
handoffs and emphasis alongside the other visuals while reusing the existing media.
