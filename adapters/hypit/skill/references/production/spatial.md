# Spatial layout

Read this when positioning or fitting media, text or a project component. Timing is explained in
[Timing](timing.md); it is independent of these coordinates. Read
[component design](component-design.md) when deciding which content shares layout or motion;
[image direction](../playbooks/craft/image-direction.md) owns the source camera view. This page owns
the destination geometry, for Performance, independent Media and project scenes alike.

## Canvas, extent and destination

The Canvas gives the final image's pixel dimensions and coordinate basis. Introduce Frames and
component scopes where they help organize the picture; they need not tile the canvas or remain
separate rectangles. Components can overlap, share motion and own local trees. Canvas itself does
not contain a central list of layers. Each rendered Present supplies its own paint order.

An IntrinsicExtent gives a source image's actual dimensions. A Frame gives the destination rectangle
a consumer should occupy. A landscape image can retain its real extent while appearing in a portrait
composition. An A-roll source has no prescribed Frame or crop. For performance remaining mostly
full-screen, its intended final aspect can guide source direction; later insets or splits remain
presentation choices. Translate required source framing into visible camera facts before generation.

```svml
<import as="space" from="@hypit/spatial@1"/>

<space:Canvas id="canvas" width="1080" height="1920"/>
<space:Extent id="photo-size" width="1600" height="1200"/>
<space:Frame id="full" within={canvas}
  left="0%" top="0%" right="100%" bottom="100%"/>
<space:Frame id="content" within={full}
  left="6%" top="8%" right="94%" bottom="90%"/>
```

Coordinates start at the top left; x increases rightward and y downward. Frame edges are positions
from the parent's left/top, so `right="94%"` is the right edge at 94% of parent width. It leaves a
6% margin. A percentage on the x axis uses the parent width; on y it uses parent height. Nesting
changes that reference rectangle. Pixel lengths use `px`.

## Anchor an object or preserve its aspect

```svml
<space:AnchoredFrame id="label" within={content}
  x="50%" y="85%" width="80%" height="12%" anchor="center"/>
<space:AspectFrame id="photo-frame" within={content}
  x="100%" y="0%" width="45%" aspect={photo-size} anchor="top-right"/>
```

AnchoredFrame pins the named point of a sized rectangle to x/y in the parent. AspectFrame derives
one dimension from the other: specify width or height, plus an Extent or a ratio such as `4/3`.
An `offset-x` or `offset-y` is an additional pixel nudge. An anchored frame can extend beyond its
parent when that is the intended composition.

For text, `space:Point` supplies a pixel position and `space:Path` supplies authored Move/Line/curve
commands. [Fonts and text](fonts-and-text.md) shows which Typography placement consumes each.

## Fit the source into the Frame

Media Track and the ordinary Performance Style share two spatial roles:

- The **destination Frame** places the visual on the Canvas and supplies its outer shape.
- The **fitted content rectangle** places the scaled source inside that Frame. Its size and position
  come from the source's real Extent and the appearance Recipe's fit and alignment choices.

Supply the destination Frame and the source's actual dimensions. A still image needs an Extent;
prepared moving media already carries its dimensions. The component calculates the content rectangle.
Border and padding reduce the area used for fitting inside the outer Frame. This inset is derived
from those settings, rather than requiring another authored Frame.

For example, with no border or padding, a `1600 × 900` image fitted into a `600 × 600` Frame becomes
`600 × 337.5` under `contain`, leaving room above and below when centered. Under `cover`, it becomes
about `1066.7 × 600`; a frame clip shows the middle square. Moving the destination moves the whole
presentation; changing content alignment changes which part of that image occupies the square.

Choose fitting through the component's appearance Recipe:

- **contain** keeps the complete image visible and may leave space around it;
- **cover** fills the destination and may crop the image;
- **stretch** changes the source proportions to occupy the destination.

The selected Media/Performance vocabulary also exposes `fit-width`, `fit-height`, `native` and `scale-down` when one
dimension or the source's own pixel size should determine the scale. The default is centered
`contain`. `fit: stretch` is spatial resizing; Media Track's `playback: stretch` is a separate choice
about video speed.

## Align the picture inside its destination

The fit aligns a point on the scaled picture with a point in the fitting area:

| Control in the appearance Recipe | Meaning |
| --- | --- |
| `frame-x`, `frame-y` | The destination alignment point, from `0` to `1` across the fitting area's width and height |
| `content-x`, `content-y` | The point on the scaled source that meets it, also from `0` to `1` |
| `fit-offset-x`, `fit-offset-y` | Additional source displacement in pixels, positive right and down |
| `fit-constraint` | `bounded` keeps the fitted rectangle within the available placement range; `free` preserves the authored alignment and offsets |

The four point coordinates default to `0.5`; offsets default to zero. To keep a cover crop aligned
to the top, use `frame-y: 0; content-y: 0;`. `frame-x` and `frame-y` are alignment fractions inside
this fitting area. Position the whole card or inset with its spatial Frame.

With `bounded`, a source larger than the fitting area keeps it covered on that axis; a smaller
source stays inside it. An offset can therefore be limited, including to zero when the dimensions
match. Use `free` when exposing space through an offset is part of the design. Choose alignment from
the actual subject and composition; these coordinates express your crop choice.

## Shape the outer frame

Clipping, border, padding, shadow and frame paint belong to the outer Frame. The shared appearance
Recipe uses `clip: frame` for a rectangular clip, `clip: rounded` with a pixel `radius` for rounded
corners, or `clip: none` to show overflow. A radius takes effect with the rounded clip.

Here is a circular presenter inset; the named Canvas, SemanticTake and imported namespaces are
already available:

```svml
<space:AnchoredFrame id="presenter-frame" within={canvas}
  x="94%" y="94%" width="320px" height="320px" anchor="bottom-right"/>
<time:Clock id="clock" frame-rate="30"/>
<time:Timeline id="speech" clock={clock}>
  <time:Take source={opening.take}/>
</time:Timeline>
<performance:Style id="presenter-style" frame={presenter-frame} appearance={look.presenter}/>
  <performance:Track id="presenter" timeline={speech.timeline} canvas={canvas}>
    <performance:Use style={presenter-style} during="program"/>
  </performance:Track>
```

```svs
look.presenter {
  stack-order: 20;
  fit: cover;
  clip: rounded;
  radius: 160;
  border-width: 3;
  border-color: #D8C7A8;
}
```

A square Frame with radius half its side makes a circle. This crops the source geometrically;
subject-shaped transparency comes from the prepared media. For a rounded card, choose a radius
appropriate to its size. Rounded clipping follows the Frame: a smaller `contain` picture sitting
away from its corners can still have square picture corners. For rounded edges that follow the
picture itself, make the Frame match its displayed aspect and place the content flush inside it.

`padding` uses quoted pixel values: `"12"` for all sides, `"8 12"` for vertical/horizontal, or
`"8 12 16 12"` for top/right/bottom/left. Border and padding both reduce the fitting area while the
outer Frame keeps its size. Padding changes where fitting happens; the clip still follows the outer
Frame. `frame-paint` colors the space behind the source, including space left by fitting. Borders
outline the Frame and `shadows` sit behind it. Sample `opacity` and filters affect the picture;
the frame's paint and decoration have their own appearance.

## Move the frame or move its contents

A lifecycle `motion` Recipe moves or fades the complete framed presentation, including its border
and paint. `Sampling` children pan, zoom or rotate the fitted picture under that frame. Use Sampling
for a moving crop or a slow push-in while a card's outline stays still:

```svml
<media:Item media={prepared.media} during={story.selection.detail}
  frame={detail-frame} appearance={look.detail}>
  <media:Sampling at="start" zoom="1"/>
  <media:Sampling at="end" zoom="1.08" y="-18"/>
</media:Item>
```

This excerpt belongs inside Media Track, with prepared media, a Selection, Frame and Recipe already
available. Sampling fields apply to a direct-source Item or Member, or a sampled Layer.
`x` and `y` are pixel offsets, `rotate` is in
degrees, and `at` follows the source unit's active span from `start` to `end`, with percentages for
intermediate keys. Sampling acts after the static fit; its movement can expose space inside the
Frame. Choose the crop and motion together for the intended coverage.

[Performance](performance.md) applies fixed or custom Styles to existing Timeline footage. A moving
Style retains the original Use Window across partial coverage and Take boundaries. A scene that
coordinates the viewport with surrounding graphics can own the shared motion in its
[component program](component-visuals.md#compose-video-and-graphics-in-one-browser-program), retaining
source playback positions.

[Media presentation](media-presentation.md) and [Performance](performance.md) own their content and
playback inputs. Read their installed vocabulary for the complete appearance and motion fields.

## Carry measured regions through the same geometry

RegionTimeline contains already measured boxes indexed by program frame. Its recipe uses normalized
`[x, y, width, height]` boxes and `null` for absent measurements, converted against the chosen Canvas.
Take-local measurements need their actual program offsets. Reframed or cropped footage needs the
corresponding spatial transform before its boxes can position text correctly.

[Caption tracking](../playbooks/craft/caption-tracking.md) explains producing and applying head
regions. In a new component's visual element tree, child positions are relative to their parent;
[component visuals](component-visuals.md) shows that final layout boundary.
