import { describe, expect, it } from "vitest";
import {
  aggregateCharacters,
  compareSourcesForRepresentative,
  groupKeyFor,
  isReferenceAssetSource,
  normalizeCharacterLabel,
  primaryImageFamilyStem
} from "../src/characters/aggregate.js";
import type { CharacterSourceRef } from "../src/characters/types.js";

describe("aggregateCharacters", () => {
  it("groups same character art across speaker ids and honorific/kana variants", () => {
    const sources = [
      source({
        sourceKey: "project\0/a/manifest.json\0hero",
        label: "project-a",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/a/manifest.json",
        poses: [pose("neutral", "media/hero-closed.png")]
      }),
      source({
        sourceKey: "project\0/b/manifest.json\0hero",
        label: "project-b",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/b/manifest.json",
        poses: [
          pose("neutral", "media/hero-closed.png"),
          pose("smile", "media/hero-smile.png")
        ]
      }),
      source({
        sourceKey: "project\0/c/manifest.json\0hero",
        label: "project-c",
        id: "hero",
        displayName: "Other Hero",
        manifestPath: "/c/manifest.json",
        poses: [pose("neutral", "media/other-hero.png")]
      }),
      // Same neru art family, different ids / honorifics → one card
      source({
        sourceKey: "project\0/d/manifest.json\0mike",
        label: "project-d",
        id: "mike",
        displayName: "ネル先生",
        manifestPath: "/d/manifest.json",
        poses: [pose("neutral", "media/characters/neru-closed.png")]
      }),
      source({
        sourceKey: "project\0/e/manifest.json\0neru",
        label: "project-e",
        id: "neru",
        displayName: "ネル先生",
        manifestPath: "/e/manifest.json",
        poses: [pose("neutral", "media/characters/neru-closed.png")]
      }),
      source({
        sourceKey: "project\0/e2/manifest.json\0neru",
        label: "project-e2",
        id: "neru",
        displayName: "ネル",
        manifestPath: "/e2/manifest.json",
        poses: [pose("neutral", "media/neru.png")]
      }),
      source({
        sourceKey: "project\0/e3/manifest.json\0neru",
        label: "project-e3",
        id: "neru",
        displayName: "ネル",
        manifestPath: "/e3/manifest.json",
        poses: [pose("neutral", "media/characters/cutout/neru-mouth-closed.png")]
      }),
      // Same speaker id with kana/width variants should merge
      source({
        sourceKey: "project\0/f/manifest.json\0itopan",
        label: "project-f",
        id: "itopan",
        displayName: "いとぱん",
        manifestPath: "/f/manifest.json",
        poses: [pose("neutral", "media/characters/itopan-mouth-closed.png")]
      }),
      source({
        sourceKey: "project\0/g/manifest.json\0itopan",
        label: "project-g",
        id: "itopan",
        displayName: "イトパン",
        manifestPath: "/g/manifest.json",
        poses: [
          pose("neutral", "media/characters/itopan-mouth-closed.png"),
          pose("smile", "media/characters/itopan-mouth-half.png")
        ]
      })
    ];

    const groups = aggregateCharacters(sources);
    expect(groups).toHaveLength(4);

    const hero = groups.find((group) => group.displayName === "Hero");
    expect(hero?.groupKey).toBe("local:hero\0hero");
    expect(hero?.sources).toHaveLength(2);
    expect(hero?.sources[0]?.label).toBe("project-b");

    const other = groups.find((group) => group.displayName === "Other Hero");
    expect(other?.groupKey).toBe("local:other-hero\0otherhero");

    const neru = groups.find((group) => normalizeCharacterLabel(group.displayName) === "ネル");
    expect(neru?.sources).toHaveLength(4);
    expect(neru?.groupKey).toBe("local:neru\0ネル");

    const itopan = groups.find((group) => group.id === "itopan");
    expect(itopan?.groupKey).toBe("local:itopan\0イトパン");
    expect(itopan?.sources).toHaveLength(2);
  });

  it("does not merge generic Host cards that only share weak image names", () => {
    const groups = aggregateCharacters([
      source({
        sourceKey: "a",
        id: "host-a",
        displayName: "Host",
        label: "proj-a",
        poses: [pose("neutral", "media/neutral.png")]
      }),
      source({
        sourceKey: "b",
        id: "host-b",
        displayName: "Host",
        label: "proj-b",
        poses: [pose("neutral", "media/neutral.png")]
      })
    ]);
    expect(groups).toHaveLength(2);
  });

  it("drops storyboard/reference speakers from the gallery entirely", () => {
    const portrait = source({
      sourceKey: "char",
      id: "itopan",
      displayName: "イトパン",
      label: "promo",
      poses: [pose("neutral", "media/characters/itopan-mouth-closed.png")]
    });
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
    expect(groups[0]!.id).toBe("itopan");
    expect(groups[0]!.sources).toHaveLength(1);
    expect(groups[0]!.sources[0]!.label).toBe("promo");
  });

  it("groups shitate provenance by kind+character+run_id (cross-project same run merges)", () => {
    const sources = [
      source({
        sourceKey: "project\0/p1/manifest.json\0hero",
        label: "p1",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/p1/manifest.json",
        provenance: { kind: "shitate", character: "hero", run_id: "run-1" },
        poses: [pose("neutral")]
      }),
      source({
        sourceKey: "project\0/p2/manifest.json\0hero",
        label: "p2",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/p2/manifest.json",
        provenance: { kind: "shitate", character: "hero", run_id: "run-1" },
        poses: [pose("neutral"), pose("smile")]
      }),
      source({
        sourceKey: "project\0/p3/manifest.json\0hero",
        label: "p3",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/p3/manifest.json",
        provenance: { kind: "shitate", character: "hero", run_id: "run-2" },
        poses: [pose("neutral")]
      })
    ];

    const groups = aggregateCharacters(sources);
    expect(groups).toHaveLength(2);

    const run1 = groups.find((group) => group.groupKey === "shitate:hero\0run-1");
    expect(run1?.sources).toHaveLength(2);
    expect(run1?.sources[0]?.label).toBe("p2");
    expect(run1?.provenance).toMatchObject({ kind: "shitate", run_id: "run-1" });

    const run2 = groups.find((group) => group.groupKey === "shitate:hero\0run-2");
    expect(run2?.sources).toHaveLength(1);
    expect(run2?.sources[0]?.label).toBe("p3");
  });

  it("orders representatives: poses → mouth → project → mtime → path", () => {
    const fewPoses = source({
      sourceKey: "a",
      kind: "project",
      label: "few",
      id: "x",
      displayName: "X",
      manifestPath: "/z/manifest.json",
      manifestModifiedAtMs: 200,
      poses: [pose("n")]
    });
    const manyPoses = source({
      sourceKey: "b",
      kind: "project",
      label: "many",
      id: "x",
      displayName: "X",
      manifestPath: "/a/manifest.json",
      manifestModifiedAtMs: 100,
      poses: [pose("n"), pose("s")]
    });
    expect(compareSourcesForRepresentative(manyPoses, fewPoses)).toBeLessThan(0);

    const withMouth = source({
      sourceKey: "c",
      kind: "project",
      label: "mouth",
      id: "x",
      displayName: "X",
      manifestPath: "/b/manifest.json",
      poses: [pose("n"), pose("s")],
      mouthFrames: [pose("0")]
    });
    expect(compareSourcesForRepresentative(withMouth, manyPoses)).toBeLessThan(0);

    const templateMany = source({
      sourceKey: "d",
      kind: "template",
      label: "tmpl",
      id: "x",
      displayName: "X",
      manifestPath: "/t/manifest.json",
      poses: [pose("n"), pose("s")],
      mouthFrames: [pose("0")]
    });
    expect(compareSourcesForRepresentative(withMouth, templateMany)).toBeLessThan(0);

    const newer = source({
      sourceKey: "e",
      kind: "project",
      label: "newer",
      id: "x",
      displayName: "X",
      manifestPath: "/c/manifest.json",
      manifestModifiedAtMs: 500,
      poses: [pose("n"), pose("s")],
      mouthFrames: [pose("0")]
    });
    expect(compareSourcesForRepresentative(newer, withMouth)).toBeLessThan(0);

    const pathEarlier = source({
      sourceKey: "f",
      kind: "project",
      label: "path-a",
      id: "x",
      displayName: "X",
      manifestPath: "/a/manifest.json",
      manifestModifiedAtMs: 500,
      poses: [pose("n"), pose("s")],
      mouthFrames: [pose("0")]
    });
    expect(compareSourcesForRepresentative(pathEarlier, newer)).toBeLessThan(0);

    const aggregated = aggregateCharacters([
      fewPoses,
      manyPoses,
      withMouth,
      templateMany,
      newer,
      pathEarlier
    ]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0]!.sources[0]!.label).toBe("path-a");
    expect(aggregated[0]!.hasMouthFrames).toBe(true);
  });

  it("exposes helpers consistently", () => {
    const local = source({
      sourceKey: "l",
      id: "a",
      displayName: "A先生",
      poses: [pose("n", "media/a-closed.png")]
    });
    expect(normalizeCharacterLabel("ネル先生")).toBe("ネル");
    expect(primaryImageFamilyStem(local)).toBe("a");
    expect(groupKeyFor(local)).toBe("local:a\0a");

    const remote = source({
      sourceKey: "r",
      id: "hero",
      displayName: "Hero",
      provenance: { kind: "shitate", character: "hero", run_id: "run-9" },
      poses: [pose("n")]
    });
    expect(groupKeyFor(remote)).toBe("shitate:hero\0run-9");
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
