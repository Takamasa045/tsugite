// Pure frame-time contract shared by native React and DOM implementations.
// No wall-clock animation, remote content, generated code or backend identifiers.
export function sampleFastEdit(manifest, time, size) {
  const f = manifest.fast_edit;
  const beat = f.beats.find((b) => time >= b.start && time < b.end);
  const vertical = size.height > size.width;
  const unit = size.width / (vertical ? 1080 : 1920);
  const speed = { high: 0.22, medium: 0.38, low: 0.65 }[f.global.energy];
  const elapsed = beat ? time - beat.start : 0;
  const p = Math.min(1, Math.max(0, elapsed / speed));
  const ease = 1 - (1 - p) ** 3;
  const palette = {
    energetic: ["#ffdb45", "#141629", "#ffffff"],
    minimal: ["#b8f1d0", "#10211e", "#ffffff"],
    editorial: ["#f3c79a", "#30231f", "#fff4e5"],
  }[f.global.style];
  const [accent, background, ink] = palette;
  const filter = {
    source: "none",
    warm: "sepia(.2) saturate(1.15)",
    cool: "saturate(.85) hue-rotate(12deg)",
    mono: "grayscale(1)",
  }[f.global.color];
  const zoom = beat
    ? { none: 1, medium: 1.15, close: 1.32 }[beat.edit.face_zoom]
    : 1;
  const transition = beat?.edit.transition;
  const video = {
    width: "100%",
    height: "100%",
    objectFit: "cover",
    filter,
    transform: `scale(${zoom * (transition === "zoom" ? 1 + 0.18 * (1 - ease) : 1)})`,
    opacity: transition === "fade" ? ease : 1,
    clipPath:
      transition === "wipe" ? `inset(0 ${(1 - ease) * 100}% 0 0)` : "none",
  };
  const common = {
    boxSizing: "border-box",
    fontFamily: 'Arial, "Hiragino Sans", sans-serif',
    color: ink,
  };
  const node = (id, text, style = {}, children = []) => ({
    id,
    text,
    style: { ...style },
    children,
  });
  const layers = [];
  if (beat) {
    const words = f.words.filter((w) => beat.word_ids.includes(w.id));
    const text = words.map((w) => w.text).join(" ");
    const focus =
      words.find((w) => w.id === beat.edit.emphasis_word_id)?.text ??
      words[0]?.text ??
      "";
    const effect = beat.edit.text_effect;
    const motion = {
      transform:
        effect === "pop"
          ? `scale(${0.8 + 0.2 * ease})`
          : effect === "rise"
            ? `translateY(${(1 - ease) * 48 * unit}px)`
            : "none",
      opacity: effect === "rise" ? ease : 1,
    };
    const outline = f.global.caption_style === "outlined";
    const caption = node(
      "fe-caption",
      "",
      {
        ...common,
        position: "absolute",
        left: "7%",
        width: "86%",
        bottom: "12%",
        padding: `${20 * unit}px ${24 * unit}px`,
        borderRadius: 16 * unit,
        background:
          f.global.caption_style === "clean"
            ? "transparent"
            : "rgba(0,0,0,.76)",
        fontSize: (vertical ? 55 : 54) * unit,
        fontWeight: f.global.caption_style === "bold" ? 900 : 700,
        lineHeight: 1.35,
        textAlign: "center",
        textShadow: outline
          ? "2px 2px 0 #000,-2px -2px 0 #000"
          : "0 2px 8px #000",
        ...motion,
      },
      words.map((w, i) =>
        node(`fe-${w.id}`, w.text + (i < words.length - 1 ? " " : ""), {
          display: "inline",
          color:
            w.id === beat.edit.emphasis_word_id &&
            time >= w.start &&
            time < w.end
              ? accent
              : ink,
          background:
            w.id === beat.edit.emphasis_word_id &&
            time >= w.start &&
            time < w.end
              ? "#463500"
              : "transparent",
          visibility:
            effect === "typewriter" && time < w.start ? "hidden" : "visible",
        }),
      ),
    );
    if (words.length) layers.push(caption);
    if (beat.edit.visual_needed && words.length) {
      const card = beat.edit.card;
      const base = {
        ...common,
        position: "absolute",
        left: "10%",
        top: vertical ? "19%" : "13%",
        width: "80%",
        minHeight: (vertical ? 230 : 160) * unit,
        padding: 32 * unit,
        borderRadius: 20 * unit,
        background: background + "ed",
        border: `${3 * unit}px solid ${accent}`,
        textAlign: "center",
        fontSize: (vertical ? 62 : 70) * unit,
        fontWeight: 800,
        lineHeight: 1.25,
        ...motion,
      };
      let title = text;
      let children = [];
      const label = (s) =>
        node("fe-card-label", s, {
          fontSize: 24 * unit,
          letterSpacing: 3 * unit,
          color: accent,
          marginBottom: 16 * unit,
        });
      const row = (w, i, mark) =>
        node(`fe-card-row-${i}`, `${mark} ${w.text}`, {
          fontSize: 38 * unit,
          textAlign: "left",
          padding: 10 * unit,
          borderBottom: `1px solid ${accent}55`,
        });
      switch (card) {
        case "keyword":
          title = focus;
          Object.assign(base, {
            color: accent,
            fontSize: 94 * unit,
            background: "#101010dd",
          });
          break;
        case "quote":
          title = `“${text}”`;
          Object.assign(base, {
            fontFamily: "Georgia, serif",
            fontStyle: "italic",
            borderLeft: `${12 * unit}px solid ${accent}`,
            borderRadius: 0,
          });
          break;
        case "stat":
          title = focus;
          children = [label("KEY FIGURE")];
          Object.assign(base, { fontSize: 110 * unit, color: accent });
          break;
        case "question":
          title = `${text} ?`;
          Object.assign(base, {
            borderRadius: 60 * unit,
            borderStyle: "dashed",
          });
          break;
        case "list":
          title = "";
          children = words.slice(0, 4).map((w, i) => row(w, i, "•"));
          break;
        case "steps":
          title = "";
          children = words.slice(0, 4).map((w, i) => row(w, i, `${i + 1}.`));
          break;
        case "comparison":
          title = "";
          Object.assign(base, {
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: 20 * unit,
          });
          children = [
            node(
              "fe-left",
              words
                .slice(0, Math.ceil(words.length / 2))
                .map((w) => w.text)
                .join(" "),
              {
                borderRight: `${4 * unit}px solid ${accent}`,
                padding: 16 * unit,
                fontSize: 40 * unit,
              },
            ),
            node(
              "fe-right",
              words
                .slice(Math.ceil(words.length / 2))
                .map((w) => w.text)
                .join(" "),
              { padding: 16 * unit, fontSize: 40 * unit },
            ),
          ];
          break;
        case "definition":
          title = text;
          children = [label(focus)];
          Object.assign(base, {
            textAlign: "left",
            fontSize: 40 * unit,
            borderTop: `${12 * unit}px solid ${accent}`,
          });
          break;
        case "highlight":
          title = focus;
          Object.assign(base, {
            background: accent,
            color: background,
            transform: `rotate(-3deg) ${motion.transform}`,
            borderRadius: 0,
          });
          break;
        case "warning":
          title = text;
          children = [label("!  ATTENTION")];
          Object.assign(base, {
            borderColor: "#ff805c",
            background: "#48251fec",
          });
          break;
        case "tip":
          title = text;
          children = [label("TIP")];
          Object.assign(base, {
            borderLeft: `${18 * unit}px solid ${accent}`,
            textAlign: "left",
          });
          break;
        case "checklist":
          title = "";
          children = words.slice(0, 4).map((w, i) => row(w, i, "✓"));
          Object.assign(base, { borderStyle: "dotted" });
          break;
        case "timeline":
          title = "";
          children = words
            .slice(0, 4)
            .map((w, i) =>
              row(w, i, `${(w.start - beat.start).toFixed(1)}s ─`),
            );
          Object.assign(base, {
            borderLeft: `${8 * unit}px solid ${accent}`,
            borderRadius: 0,
          });
          break;
        case "counter":
          title = `${String(f.beats.indexOf(beat) + 1).padStart(2, "0")} / ${f.beats.length}`;
          children = [label(focus)];
          Object.assign(base, {
            fontVariantNumeric: "tabular-nums",
            borderRadius: 100 * unit,
            color: accent,
          });
          break;
        case "title":
          title = text;
          Object.assign(base, {
            background: "transparent",
            border: 0,
            fontSize: 82 * unit,
            textShadow: "0 3px 14px #000",
            textTransform: "uppercase",
          });
          break;
        case "lower_third":
          title = text;
          Object.assign(base, {
            top: "60%",
            width: "70%",
            left: "5%",
            fontSize: 38 * unit,
            textAlign: "left",
            borderRadius: 0,
            borderLeft: `${12 * unit}px solid ${accent}`,
          });
          break;
        case "callout":
          title = `→ ${focus}`;
          Object.assign(base, {
            left: "20%",
            width: "65%",
            borderRadius: `${70 * unit}px ${70 * unit}px ${70 * unit}px 0`,
            textAlign: "left",
          });
          break;
        case "cta":
          title = text;
          children = [label("NEXT →")];
          Object.assign(base, {
            background: accent,
            color: background,
            borderRadius: 90 * unit,
            boxShadow: `0 ${12 * unit}px 0 #0006`,
          });
          break;
        default:
          throw new Error(`Unknown Fast Edit card: ${card}`);
      }
      layers.push(
        node("fe-card", "", base, [...children, node("fe-card-text", title)]),
      );
    }
  }
  if (f.global.progress_bar !== "none")
    layers.push(
      node("fe-progress", "", {
        position: "absolute",
        left: 0,
        [f.global.progress_bar]: 0,
        height: 10 * unit,
        width: `${Math.max(0, Math.min(1, time / manifest.meta.target_duration_seconds)) * 100}%`,
        background: accent,
      }),
    );
  return { video, layers };
}

export function createFastEditDom(manifest, size, container, videos) {
  const applyStyle = (el, style) => {
    for (const [key, value] of Object.entries(style))
      el.style[key] =
        typeof value === "number" &&
        !["opacity", "fontWeight", "lineHeight", "zIndex"].includes(key)
          ? `${value}px`
          : String(value);
  };
  const make = (n) => {
    const el = document.createElement(
      n.style.display === "inline" ? "span" : "div",
    );
    el.id = n.id;
    el.textContent = n.text;
    applyStyle(el, n.style);
    n.children.forEach((c) => el.append(make(c)));
    return el;
  };
  return (time) => {
    const scene = sampleFastEdit(manifest, time, size);
    let start = 0;
    videos.forEach((v, index) => {
      const end = start + manifest.clips[index].duration;
      applyStyle(v, {
        ...scene.video,
        opacity: time >= start && time < end ? scene.video.opacity : 0,
      });
      start = end;
    });
    container.replaceChildren(...scene.layers.map(make));
  };
}
export function browserSceneSource(manifest, size) {
  const safe = (value) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `${sampleFastEdit.toString()}\n${createFastEditDom.toString()}\nconst FAST_MANIFEST=${safe(manifest)}; const FAST_SIZE=${safe(size)};`;
}
