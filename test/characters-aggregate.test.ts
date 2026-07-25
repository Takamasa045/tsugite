import { describe, expect, it } from "vitest";
import {
  aggregateCharacters,
  compareSourcesForRepresentative,
  groupKeyFor
} from "../src/characters/aggregate.js";
import type { CharacterSourceRef } from "../src/characters/types.js";

describe("aggregateCharacters", () => {
  it("groups local sources by id + displayName across projects", () => {
    const sources = [
      source({
        sourceKey: "project\0/a/manifest.json\0hero",
        label: "project-a",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/a/manifest.json",
        poses: [pose("neutral")]
      }),
      source({
        sourceKey: "project\0/b/manifest.json\0hero",
        label: "project-b",
        id: "hero",
        displayName: "Hero",
        manifestPath: "/b/manifest.json",
        poses: [pose("neutral"), pose("smile")]
      }),
      source({
        sourceKey: "project\0/c/manifest.json\0hero",
        label: "project-c",
        id: "hero",
        displayName: "Other Hero",
        manifestPath: "/c/manifest.json",
        poses: [pose("neutral")]
      })
    ];

    const groups = aggregateCharacters(sources);
    expect(groups).toHaveLength(2);

    const hero = groups.find((group) => group.displayName === "Hero");
    expect(hero?.groupKey).toBe("local:hero\0Hero");
    expect(hero?.sources).toHaveLength(2);
    // Representative: more poses first
    expect(hero?.sources[0]?.label).toBe("project-b");
    expect(hero?.poseCount).toBe(2);

    const other = groups.find((group) => group.displayName === "Other Hero");
    expect(other?.groupKey).toBe("local:hero\0Other Hero");
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

  it("exposes groupKeyFor consistently with aggregate grouping", () => {
    const local = source({
      sourceKey: "l",
      id: "a",
      displayName: "A",
      poses: [pose("n")]
    });
    expect(groupKeyFor(local)).toBe("local:a\0A");

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

function pose(name: string) {
  return { name, imageId: `${name}-id`, imagePath: `media/${name}.png`, missing: false };
}

function source(partial: Partial<CharacterSourceRef> & Pick<CharacterSourceRef, "sourceKey" | "id" | "displayName" | "poses">): CharacterSourceRef {
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
