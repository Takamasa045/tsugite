import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  aggregateCharacters,
  compareSourcesForRepresentative,
  groupKeyFor,
  isReferenceAssetSource,
  normalizeCharacterLabel
} from "../src/characters/aggregate.js";
import type { CharacterSourceRef } from "../src/characters/types.js";

function sha(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

describe("aggregateCharacters", () => {
  it("groups by portrait content hash + honorific-stripped label", () => {
    const neruSha = sha("neru-art");
    const otherSha = sha("other-art");
    const sources = [
      source({
        sourceKey: "a",
        id: "neru",
        displayName: "ネル",
        label: "proj-a",
        primaryImageSha256: neruSha,
        poses: [pose("neutral", "media/neru-closed.png")]
      }),
      source({
        sourceKey: "b",
        id: "mike",
        displayName: "ネル先生",
        label: "proj-b",
        primaryImageSha256: neruSha,
        poses: [pose("neutral", "media/characters/neru-closed.png")]
      }),
      source({
        sourceKey: "c",
        id: "neru",
        displayName: "ネル先生",
        label: "proj-c",
        primaryImageSha256: neruSha,
        poses: [pose("neutral", "media/characters/neru.png"), pose("smile", "media/smile.png")]
      }),
      // Same filename, different bytes → different card
      source({
        sourceKey: "d",
        id: "hero-a",
        displayName: "Hero",
        label: "proj-d",
        primaryImageSha256: sha("hero-a-bytes"),
        poses: [pose("neutral", "media/hero.png")]
      }),
      source({
        sourceKey: "e",
        id: "hero-b",
        displayName: "Hero",
        label: "proj-e",
        primaryImageSha256: sha("hero-b-bytes"),
        poses: [pose("neutral", "media/hero.png")]
      }),
      // Kana variants same bytes
      source({
        sourceKey: "f",
        id: "itopan",
        displayName: "いとぱん",
        label: "proj-f",
        primaryImageSha256: otherSha,
        poses: [pose("neutral", "media/itopan.png")]
      }),
      source({
        sourceKey: "g",
        id: "itopan",
        displayName: "イトパン",
        label: "proj-g",
        primaryImageSha256: otherSha,
        poses: [pose("neutral", "media/itopan.png"), pose("smile", "media/itopan2.png")]
      })
    ];

    const groups = aggregateCharacters(sources);
    expect(groups).toHaveLength(4);

    const neru = groups.find((group) => normalizeCharacterLabel(group.displayName) === "ネル");
    expect(neru?.sources).toHaveLength(3);
    expect(neru?.groupKey).toBe(`local:sha:${neruSha}\0ネル`);
    expect(neru?.sources[0]?.label).toBe("proj-c");

    const heroes = groups.filter((group) => group.displayName === "Hero");
    expect(heroes).toHaveLength(2);

    const itopan = groups.find((group) => group.id === "itopan");
    expect(itopan?.sources).toHaveLength(2);
  });

  it("falls back to speaker id when portrait hash is missing", () => {
    const groups = aggregateCharacters([
      source({
        sourceKey: "a",
        id: "host-a",
        displayName: "Host",
        poses: [pose("neutral", "media/neutral.png")]
      }),
      source({
        sourceKey: "b",
        id: "host-b",
        displayName: "Host",
        poses: [pose("neutral", "media/neutral.png")]
      })
    ]);
    expect(groups).toHaveLength(2);
  });

  it("drops storyboard/review speakers and does not drop frame-* portrait ids", () => {
    const portrait = source({
      sourceKey: "char",
      id: "hero",
      displayName: "Hero",
      label: "promo",
      primaryImageSha256: sha("portrait"),
      poses: [pose("neutral", "media/characters/frame-neutral.png")]
    });
    // imageId starts with frame- but path is normal character media — keep
    portrait.poses[0]!.imageId = "frame-neutral";

    const reference = source({
      sourceKey: "ref",
      id: "host",
      displayName: "いとぱん",
      label: "digest",
      poses: [
        {
          name: "hook",
      imageId: "frame-hook",
          imagePath: "review/references/01-hook.png",
          missing: false
        },
        {
          name: "grow",
      imageId: "frame-grow",
          imagePath: "review/references/02-grow.png",
          missing: false
        }
      ]
    });

    expect(isReferenceAssetSource(reference)).toBe(true);
    expect(isReferenceAssetSource(portrait)).toBe(false);

    const groups = aggregateCharacters([reference, portrait]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.id).toBe("hero");
  });

  it("groups shitate provenance by kind+character+run_id", () => {
    const sources = [
      source({
        sourceKey: "p1",
        label: "p1",
        id: "hero",
        displayName: "Hero",
        provenance: { kind: "shitate", character: "hero", run_id: "run-1" },
        poses: [pose("neutral")]
      }),
      source({
        sourceKey: "p2",
        label: "p2",
        id: "hero",
        displayName: "Hero",
        provenance: { kind: "shitate", character: "hero", run_id: "run-1" },
        poses: [pose("neutral"), pose("smile")]
      }),
      source({
        sourceKey: "p3",
        label: "p3",
        id: "hero",
        displayName: "Hero",
        provenance: { kind: "shitate", character: "hero", run_id: "run-2" },
        poses: [pose("neutral")]
      })
    ];

    const groups = aggregateCharacters(sources);
    expect(groups).toHaveLength(2);
    expect(groups.find((group) => group.groupKey === "shitate:hero\0run-1")?.sources).toHaveLength(2);
  });

  it("orders representatives: poses → mouth → project → mtime → path", () => {
    const few = source({
      sourceKey: "a",
      label: "few",
      id: "x",
      displayName: "X",
      primaryImageSha256: sha("x"),
      manifestPath: "/z/manifest.json",
      poses: [pose("n")]
    });
    const many = source({
      sourceKey: "b",
      label: "many",
      id: "x",
      displayName: "X",
      primaryImageSha256: sha("x"),
      manifestPath: "/a/manifest.json",
      poses: [pose("n"), pose("s")]
    });
    expect(compareSourcesForRepresentative(many, few)).toBeLessThan(0);
    expect(aggregateCharacters([few, many])[0]!.sources[0]!.label).toBe("many");
  });

  it("exposes groupKeyFor helpers", () => {
    const hashed = source({
      sourceKey: "l",
      id: "a",
      displayName: "A先生",
      primaryImageSha256: "abc",
      poses: [pose("n")]
    });
    expect(normalizeCharacterLabel("ネル先生")).toBe("ネル");
    expect(groupKeyFor(hashed)).toBe("local:sha:abc\0a");
    expect(groupKeyFor(source({
      sourceKey: "r",
      id: "hero",
      displayName: "Hero",
      provenance: { kind: "shitate", character: "hero", run_id: "run-9" },
      poses: [pose("n")]
    }))).toBe("shitate:hero\0run-9");
  });
});

function pose(name: string, imagePath = `media/${name}.png`) {
  return {
    name,
    imageId: `${name}-id`,
    imagePath,
    missing: false
  };
}

function source(
  partial: Partial<CharacterSourceRef> & Pick<CharacterSourceRef, "sourceKey" | "id" | "displayName" | "poses">
): CharacterSourceRef {
  return {
    kind: "project",
    label: partial.label ?? "label",
    manifestPath: partial.manifestPath ?? "/manifest.json",
    rootDir: partial.rootDir ?? "/",
    side: partial.side ?? "left",
    accent: partial.accent ?? "#000000",
    manifestModifiedAtMs: partial.manifestModifiedAtMs ?? 0,
    ...partial
  };
}
