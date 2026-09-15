# Writing a Caption family

Read this when a work needs a new relationship among its spoken words, layout and motion.
[Caption craft](../playbooks/craft/captions.md) owns readability and directing judgment;
[Caption styling and coverage](caption-presentation.md) owns applying visible and hidden Styles;
[Track authoring](track-authoring.md) owns project package wiring.
[Fonts and text](fonts-and-text.md) explains exact font resources and fallbacks;
[component visuals](component-visuals.md) explains the final drawing representation.
[Component design](component-design.md) connects a new family's visual idea to useful author controls
and its fit beside the rest of the video.

## Decide what is actually new

Fine Caption already covers uniform flowing text with exact fonts, Paint, boxes, karaoke states,
placement and motion. Different colors, Role styles, cue entrances or head tracking may only require
Source and Recipe changes. A keyword occupying a separate oversized line, words playing different
visual roles, or a recurring spatial relationship among speakers can justify a new family directly.
Creating that family is normal video production. Name the family for the visual relationship it
makes reusable, and name each Style for a particular treatment within it. A project can also own a
single-use caption composition when that is what the video needs.

The result is still Caption when the displayed words correspond to speech and remain close to its
delivery. Independent slogans, summaries and titles usually belong to Typography even if they react
to a Script Moment.

## Own the visual relationship

Media can present ordinary footage; a scene component can coordinate footage with diagrams or other
graphics. Fine and custom Caption families have the same relationship. Their shared input is the
authored speech and its semantic timing; the implementation owns the spatial structure and motion.

Start from what the viewer should understand or feel. A supporting phrase might establish the
thought while its key word takes the emphasis. Design how they enter, share space, respond to speech
and hand off to the next thought. That relationship suggests useful controls: the word's authored
role, fonts, relative sizes, placement and motion. Put the work's choices in its Style/Recipe and
the reusable arrangement in the renderer.

The output remains an ordinary VisualTrack. Its Presents can own trees of text, boxes, images and
other visual elements. When words and graphics share layout or motion, they can live in the same
component. [Component visuals](component-visuals.md#compose-video-and-graphics-in-one-browser-program)
also describes HTML/CSS browser programs with typed media and text children. That drawing freedom
applies to captions too: give the program the resolved caption schedule and explicit resources,
and evaluate its state at the requested frame. Keep separately useful overlays as peers.

## Keep the existing text and timing chain

```text
Script → CaptionDocument (displayed words, Cue breaks and word attributes)
CaptionDocument + Timeline → complete timed Cues and original word times
Track Uses → resolved time windows, Styles and optional speaker filters
complete Cues + Uses + family parameters → family schedule → VisualTrack
```

Use `@hypit/hypit/caption` for content timing and Use coverage, and `@hypit/hypit/narrative` for
Script document types. A family Track accepts `document`, `timeline` and ordered `Use` children:

```svml
<keyword:Track id="captions" document={story.caption} timeline={film.timeline}>
  <keyword:Use style={base-style}/>
  <keyword:Use role="GUEST" style={guest-style}/>
  <keyword:Use during={story.selection.punchline} style={punchline-style}/>
</keyword:Track>
```

These names assume the project family and its Styles have been declared. Reuse the common time
projection helpers for `during`, `at`/`for`, `until`/`for` and `start`/`end`. A Use has the same
meaning regardless of the family. `role` filters whose content it presents within that window.

For a keyword layout, Script can mark `useful{emphasis}`. The family reads that attribute from the
CaptionDocument and gives it a visual role within the complete Cue. The word role and the time
window answer different questions; an emphasis attribute does not invent another time language.

## Design a family-specific schedule

Separate measured speech time from visible time. Preserve each alignment unit's measured boundaries
and identity; resolve lead, tail, stagger, hold and handoff into an explicit schedule before rendering.
The renderer draws that schedule. Preserve a Cue's original animation origin and apply the
winning Use window as a separate visibility mask. A window starting midway through a Cue still
receives the complete Cue and original word times. It can change appearance without restarting
karaoke or text reveal.

For a “large keyword plus supporting phrase” family, the schedule might identify each Cue's display
words, its emphasized word ids, their measured units and the visible interval of the two groups.
Its layout then computes the two groups together. Decide what happens with no keyword, several
keywords, long text and an N:M pronunciation span. Make author correction possible through word
attributes, `||` and Style configuration instead of inventing missing text or dropping words.

The common projection respects authored Cue breaks and structural boundaries. Visual line wrapping
is a separate operation. A narrow width should not silently rewrite the Script into new spoken Cues.
If the family needs an additional grouping rule, give that rule explicit parameters and preserve the
original word/unit associations in the schedule.

Display Words follow the Script's writing system: a Han character is normally one Word, while an
English word is normally one Word. Keep that timing granularity separate from a phrase's visual
grouping. Compose adjacent Han characters without Latin word gaps, preserve punctuation with its
word, and use the selected fonts' actual widths for layout. Exercise mixed-script names as well as
plain English when the family will carry Chinese copy.

For speech-following emphasis, activate each complete unit from its projected start and end.
A Cue-wide left-to-right progress bar follows elapsed time and text width, which is a different
effect from following spoken characters. Keep within-glyph wiping an explicit visual choice.
Use uneven unit durations and a pause in a short example to check that the chosen effect follows
the intended clock.

`caption:Hidden` supplies a Style with `rendering: null`. It takes part in later-Use precedence,
clearing this Track's presentation in its window; a later visible Use can restore a smaller window.
Use `captionUseVisibility` to resolve that coverage for each Cue's speaker. The content projection
retains all Cues regardless of Style. Empty or uncovered time naturally produces no drawing.

## Give Style, layout and rendering clear owners

The Style Surface validates a Recipe and exact font references, then emits the common Caption Style
shape with the new family's name and parameters. The Track Surface accepts the document,
Timeline and timed Use children; its Fragment assembles the Uses, performs the common timing join,
and runs its own schedule and render operations. Register the new family's Producers and any new schedule Type in its own package.

The renderer owns typography, structural relationships, stacking and motion. Use the existing text
shaping and Visual IR facilities with explicit font resources, including selected local font files,
so the same faces reach the rendering machine.
Read `@hypit/caption-fine`'s `surface.ts`, `schedule.ts` and `render.ts` as separate implementation
examples. Reuse the common parts and replace the actual family behavior, including its parameter
validation; renaming Fine while retaining its uniform-word assumption will not implement a structural
keyword treatment.

The chosen family interprets its own Styles. Fine handles its uniform-flow Styles; a structural
family handles its own layouts. Each Track is independent, so multiple Tracks can intentionally
show captions together or use complementary coverage. Mixed-family rendering, if useful, belongs
to the component that implements it.

If this family supports spatial tracking, take an explicit RegionTimeline and map it into the actual
composition. Define subject matching and absent-region behavior. Detection belongs to the measurement
step described in [Caption tracking](../playbooks/craft/caption-tracking.md), not to this renderer.

## Check the relationships that matter

Use a short Script with a normal phrase, the new structural treatment, a Role change and a Dual Text
unit. Verify displayed words and their association with measured speech, then inspect the new layout
at the intended frame size and around its handoffs. Check long words, overflow and direct seeking
where relevant. A still can show typography; only the configured timeline establishes timing.

Expose the family with useful vocabulary and a designed preview. Keep wording, font choices, palette
and authored word roles editable in the project. The package adds its rendering language while
consuming the existing Script, Caption and semantic-time owners.

For live Cue entities and Inspector editing, add a [Studio Companion](studio.md#give-a-project-component-a-useful-companion)
that presents complete Cue content and authored Uses as separate lanes. Read the Track's resolved
Use collection, retain each child's Source range and temporal lineage, and expose the referenced
Style on that Use. Caption Fine's
Companion is a useful example of these relationships; the new family's layout stays in its renderer.
