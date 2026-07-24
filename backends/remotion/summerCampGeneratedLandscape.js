import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { designScale } from "./presentation.mjs";

export const SUMMER_CAMP_GENERATED_LANDSCAPE_PRESET = "tsugite-summer-camp-generated-16x9";

const h = React.createElement;
const SERIF = '"Shippori Mincho", "Hiragino Mincho ProN", "Yu Mincho", serif';
const SANS = '"Noto Sans JP", "Hiragino Sans", "Yu Gothic", sans-serif';
const C = { paper: "#fff8eb", cedar: "#774323", brass: "#d5b36c", coral: "#ff7d61" };

export function generatedSummerCampMotion(frame, durationFrames) {
  const enter = interpolate(frame, [0, 8], [0, 1], {
    easing: Easing.bezier(.16, 1, .3, 1), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  const exit = interpolate(frame, [Math.max(0, durationFrames - 5), durationFrames], [0, 1], {
    easing: Easing.in(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  return { enter, visible: enter * (1 - exit) };
}

export function SummerCampGeneratedLandscape({ manifest }) {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const second = frame / fps;
  const captions = manifest.captions ?? [];
  const scene = captions.find((caption) => second >= caption.start && second < caption.end);
  if (!scene) return null;

  const localFrame = frame - Math.round(scene.start * fps);
  const durationFrames = Math.max(1, Math.round((scene.end - scene.start) * fps));
  const motion = generatedSummerCampMotion(localFrame, durationFrames);
  const visual = scene.visual ?? {};
  const isPrice = visual.kind === "price";
  const headline = visual.headline ?? scene.text;
  const shift = interpolate(motion.enter, [0, 1], [28, 0]);
  const accentWidth = interpolate(localFrame, [4, 14], [0, 76], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  const scale = designScale(width, height);
  const left = (width - 1920 * scale) / 2;
  const top = (height - 1080 * scale) / 2;

  return h(AbsoluteFill, { style: { overflow: "hidden", color: C.paper, fontFamily: SANS, pointerEvents: "none" } },
    h("div", { style: { position: "absolute", inset: 0, background: "linear-gradient(90deg, rgba(11,13,11,.84), rgba(11,13,11,.45) 48%, rgba(11,13,11,.08))" } }),
    h("div", { style: { position: "absolute", inset: 0, opacity: .17, background: "repeating-linear-gradient(0deg, transparent 0 7px, rgba(255,248,235,.12) 8px 9px)" } }),
    h("div", { style: { position: "absolute", left, top, width: 1920, height: 1080, transform: `scale(${scale})`, transformOrigin: "top left" } },
      h(Brand),
      h(JoineryLock, { localFrame }),
      h("div", { style: { position: "absolute", left: 82, right: 82, top: 148, bottom: 110, display: "flex", alignItems: "center", opacity: motion.visible, transform: `translateX(${shift}px)` } },
        h("div", { style: { maxWidth: "100%" } },
          h("div", { style: { color: C.brass, fontFamily: "monospace", fontSize: 18, fontWeight: 900, letterSpacing: ".13em", textShadow: "0 2px 12px rgba(0,0,0,.7)" } }, visual.kicker ?? "TSUGITE SUMMER CAMP"),
          h("div", { style: { width: accentWidth, height: 5, marginTop: 13, background: C.coral } }),
          isPrice ? h(Price, { visual, localFrame }) : h(Story, { headline, visual, localFrame })
        )
      )
    )
  );
}

function Brand() {
  return h("div", { style: { position: "absolute", zIndex: 2, left: 82, top: 54, display: "flex", alignItems: "center", gap: 14 } },
    h("div", { style: { display: "grid", placeItems: "center", width: 42, height: 42, border: `1px solid ${C.brass}`, background: "linear-gradient(135deg, #3a2115, #ad6c3d)", fontFamily: SERIF, fontSize: 21, fontWeight: 900 } }, "継"),
    h("div", { style: { fontFamily: SERIF, fontSize: 24, fontWeight: 900, letterSpacing: ".08em", textShadow: "0 2px 15px rgba(0,0,0,.7)" } }, "Tsugite 夏の制作合宿")
  );
}

function JoineryLock({ localFrame }) {
  const lock = interpolate(localFrame, [0, 9], [0, 1], { easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const offset = interpolate(lock, [0, 1], [205, 0]);
  return h(React.Fragment, null,
    h("div", { style: { position: "absolute", left: -80 + offset, bottom: 0, width: 308, height: 96, opacity: .92, background: "linear-gradient(120deg, #2d180e, #a76038)", clipPath: "polygon(0 0,72% 0,72% 30%,100% 30%,100% 70%,72% 70%,72% 100%,0 100%)" } }),
    h("div", { style: { position: "absolute", left: 228 - offset, bottom: 0, width: 308, height: 96, opacity: .92, background: "linear-gradient(120deg, #d5b36c, #774323)", clipPath: "polygon(0 0,100% 0,100% 100%,0 100%,0 70%,28% 70%,28% 30%,0 30%)" } }),
    h("div", { style: { position: "absolute", left: 492, bottom: 34, width: 11, height: 27, background: C.coral, opacity: lock, transform: "rotate(45deg)" } })
  );
}

function Story({ headline, visual, localFrame }) {
  const detailEnter = interpolate(localFrame, [5, 14], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  const pointsEnter = interpolate(localFrame, [9, 18], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  return h(React.Fragment, null,
    visual.sale_label ? h("div", { style: { display: "inline-block", marginTop: 20, padding: "9px 16px", color: "#20130e", background: C.coral, fontSize: 24, fontWeight: 900, letterSpacing: ".04em", boxShadow: "7px 7px 0 rgba(213,179,108,.25)" } }, visual.sale_label) : null,
    h("div", { style: { marginTop: visual.sale_label ? 16 : 22, maxWidth: 1180, fontFamily: SERIF, fontSize: fittedHeadlineSize(headline, 104), lineHeight: 1.08, fontWeight: 900, letterSpacing: "-.05em", whiteSpace: "pre-line", overflowWrap: "anywhere", textShadow: "0 4px 25px rgba(0,0,0,.55)" } }, headline),
    visual.detail ? h("div", { style: { marginTop: 24, maxWidth: 990, fontSize: 31, fontWeight: 700, lineHeight: 1.42, opacity: detailEnter, transform: `translateY(${(1 - detailEnter) * 12}px)`, textShadow: "0 2px 15px rgba(0,0,0,.7)" } }, visual.detail) : null,
    (visual.points ?? []).length ? h("div", { style: { display: "flex", flexWrap: "wrap", gap: 12, marginTop: 30, opacity: pointsEnter, transform: `translateY(${(1 - pointsEnter) * 10}px)` } },
      ...visual.points.map((point, index) => h("div", { key: point, style: { padding: "10px 17px", border: `1px solid ${index === 0 ? C.brass : "rgba(255,248,235,.65)"}`, background: "rgba(18,13,10,.58)", fontSize: 22, fontWeight: 800, boxShadow: index === 0 ? "6px 6px 0 rgba(213,179,108,.16)" : "none" } }, point))
    ) : null
  );
}

function Price({ visual, localFrame }) {
  const cardsEnter = interpolate(localFrame, [7, 18], [0, 1], {
    easing: Easing.out(Easing.cubic), extrapolateLeft: "clamp", extrapolateRight: "clamp"
  });
  return h("div", { style: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) 300px 300px", gap: 18, alignItems: "end", marginTop: 24, maxWidth: 1540 } },
    h("div", { style: { maxWidth: 760, fontFamily: SERIF, fontSize: fittedHeadlineSize(visual.headline ?? "", 86), fontWeight: 900, lineHeight: 1.08, letterSpacing: "-.05em", overflowWrap: "anywhere", textShadow: "0 4px 25px rgba(0,0,0,.55)" } }, visual.headline),
    h("div", { style: { opacity: cardsEnter, transform: `translateY(${(1 - cardsEnter) * 18}px)` } },
    h(PriceCard, { label: visual.today_label, price: visual.today_price, active: true }),
    ),
    h("div", { style: { opacity: cardsEnter, transform: `translateY(${(1 - cardsEnter) * 18}px)` } },
      h(PriceCard, { label: visual.after_label, price: visual.after_price })
    )
  );
}

function PriceCard({ label, price, active = false }) {
  return h("div", { style: { padding: "22px 22px", border: `${active ? 3 : 1}px solid ${active ? C.coral : C.brass}`, background: "rgba(19,13,10,.82)", boxShadow: active ? "10px 10px 0 rgba(255,125,97,.28)" : "none" } },
    h("div", { style: { color: active ? C.coral : C.brass, fontFamily: "monospace", fontSize: 17, fontWeight: 900 } }, label),
    h("div", { style: { marginTop: 11, fontFamily: SERIF, fontSize: 53, fontWeight: 900, whiteSpace: "nowrap" } }, price)
  );
}

function fittedHeadlineSize(text, largeSize) {
  if (text.length > 22) return Math.min(largeSize, 66);
  if (text.length > 15) return Math.min(largeSize, 78);
  if (text.length > 12) return Math.min(largeSize, 88);
  return largeSize;
}
