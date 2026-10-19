import { existsSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

const README_LINE_LIMIT = 200;
const FORBIDDEN_BEFORE_START = ["manifest", "adapter", "backend", "worktree", "edl", "webmcp", "fixture"] as const;
const SCREENSHOT_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);
const GUIDE_ASSET_ROOT = "docs/guide";

const READMES = [
  {
    path: "README.ja.md",
    referenceLink: "docs/reference.ja.md",
    startHeading: "## はじめ方",
    firstHeadings: ["## こんな人に", "## はじめ方", "## 終わったら見えるもの"],
    requestNeedle: "https://github.com/Takamasa045/tsugite"
  },
  {
    path: "README.md",
    referenceLink: "docs/reference.md",
    startHeading: "## Get started",
    firstHeadings: ["## Who it's for", "## Get started", "## What you'll see"],
    requestNeedle: "https://github.com/Takamasa045/tsugite"
  }
] as const;

const DOC_ROOTS = ["README.ja.md", "README.md", "docs/guide", "docs/reference.md", "docs/reference.ja.md"] as const;

describe("README onboarding contract", () => {
  it("keeps Japanese and English READMEs short enough for a 30-second scan", async () => {
    for (const readme of READMES) {
      const text = await readFile(readme.path, "utf8");
      const lineCount = countLines(text);
      expect(lineCount, `${readme.path} has ${lineCount} lines`).toBeLessThanOrEqual(README_LINE_LIMIT);
    }
  });

  it("puts the value sentence, three steps, setup request, and reference link within the first three ## headings", async () => {
    for (const readme of READMES) {
      const text = await readFile(readme.path, "utf8");
      const stripped = stripFencedCode(text);
      const headings = h2Headings(stripped);
      expect(headings.slice(0, 3).map((heading) => heading.line), readme.path).toEqual(readme.firstHeadings);

      const intro = text.slice(0, headings[0]?.index ?? text.length);
      expect(introHasValueSentence(intro), `${readme.path} intro value sentence`).toBe(true);

      const prefix = contentThroughNthH2(text, 3);
      expect(prefix, readme.path).toContain(readme.requestNeedle);
      expect(prefix, readme.path).toContain(readme.referenceLink);
      expect(sectionByHeading(text, readme.startHeading), readme.path).toMatch(/1\.\s/);
      expect(sectionByHeading(text, readme.startHeading), readme.path).toMatch(/2\.\s/);
      expect(sectionByHeading(text, readme.startHeading), readme.path).toMatch(/3\.\s/);
      expect(fencedBlocks(prefix).some((block) => block.includes(readme.requestNeedle)), `${readme.path} paste-in request`).toBe(true);
    }
  });

  it("hides pipeline jargon until after the start heading, except parenthetical official names", async () => {
    for (const readme of READMES) {
      const text = await readFile(readme.path, "utf8");
      const beforeStart = text.slice(0, headingIndex(text, readme.startHeading));
      expect(headingIndex(text, readme.startHeading), `${readme.path} ${readme.startHeading}`).toBeGreaterThan(0);
      const visible = withoutParentheticals(stripFencedCode(beforeStart));
      for (const term of FORBIDDEN_BEFORE_START) {
        expect(visible, `${readme.path} before ${readme.startHeading}`).not.toMatch(termBoundary(term));
      }
    }
  });

  it("resolves relative links in README, guide, and reference docs to real files", async () => {
    const files = await collectMarkdownFiles(DOC_ROOTS);
    expect(files.length).toBeGreaterThan(3);
    const missing: string[] = [];
    for (const file of files) {
      const text = await readFile(file, "utf8");
      for (const target of markdownLinkTargets(stripFencedCode(text))) {
        if (shouldSkipLink(target)) continue;
        const resolved = resolveMarkdownTarget(file, target);
        if (!resolved || !existsSync(resolved)) {
          missing.push(`${file} -> ${target}`);
        }
      }
    }
    expect(missing, missing.join("\n")).toEqual([]);
  });

  it("requires a README screenshot only after a real guide image exists", async () => {
    const screenshots = await collectScreenshotFiles(GUIDE_ASSET_ROOT);
    for (const readme of READMES) {
      const text = await readFile(readme.path, "utf8");
      const images = markdownImages(stripFencedCode(text));
      if (screenshots.length === 0) {
        expect(images, `${readme.path} Phase 1 has no screenshot files, so README must not embed images`).toEqual([]);
        continue;
      }
      const prefix = stripFencedCode(contentThroughNthH2(text, 3));
      const prefixImages = markdownImages(prefix);
      expect(prefixImages.length, `${readme.path} Phase 2 needs one screenshot in the first three ## sections`).toBeGreaterThanOrEqual(1);
      const alts = markdownImageAlts(prefix);
      expect(alts.length, `${readme.path} screenshot alt count`).toBe(prefixImages.length);
      for (const [index, image] of prefixImages.entries()) {
        const resolved = resolveMarkdownTarget(readme.path, image);
        expect(resolved && existsSync(resolved), `${readme.path} -> ${image}`).toBe(true);
        expect(alts[index]?.trim().length, `${readme.path} screenshot needs alt text`).toBeGreaterThan(0);
      }
    }
  });
});

function countLines(text: string): number {
  if (text.length === 0) return 0;
  const normalized = text.endsWith("\n") ? text.slice(0, -1) : text;
  return normalized.length === 0 ? 0 : normalized.split("\n").length;
}

function stripFencedCode(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => block.replace(/[^\n]/g, " "));
}

function h2Headings(text: string): Array<{ line: string; index: number }> {
  const headings: Array<{ line: string; index: number }> = [];
  const pattern = /^## .+$/gm;
  for (const match of text.matchAll(pattern)) {
    headings.push({ line: match[0].trimEnd(), index: match.index ?? 0 });
  }
  return headings;
}

function headingIndex(text: string, heading: string): number {
  const match = h2Headings(stripFencedCode(text)).find((item) => item.line === heading);
  return match?.index ?? -1;
}

function contentThroughNthH2(text: string, n: number): string {
  const headings = h2Headings(stripFencedCode(text));
  if (headings.length < n) return text;
  const next = headings[n];
  return next ? text.slice(0, next.index) : text;
}

function sectionByHeading(text: string, heading: string): string {
  const headings = h2Headings(stripFencedCode(text));
  const start = headings.findIndex((item) => item.line === heading);
  if (start < 0) return "";
  const end = headings[start + 1]?.index ?? text.length;
  return text.slice(headings[start].index, end);
}

function introHasValueSentence(intro: string): boolean {
  const paragraphs = intro
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && !part.startsWith("#") && !part.startsWith("[日本語") && !part.startsWith("[English") && !part.startsWith("[中文"));
  return paragraphs.some((part) => part.replace(/\[[^\]]+\]\([^)]+\)/g, "").trim().length >= 20);
}

function fencedBlocks(text: string): string[] {
  return [...text.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
}

function withoutParentheticals(text: string): string {
  return text.replace(/（[^）]*）/g, " ").replace(/\([^)]*\)/g, " ");
}

function termBoundary(term: string): RegExp {
  return new RegExp(`(^|[^A-Za-z0-9_])${term}([^A-Za-z0-9_]|$)`, "i");
}

function markdownLinkTargets(text: string): string[] {
  const targets: string[] = [];
  const pattern = /!?\[(?:[^\]]|\\\])*\]\(\s*<?([^>\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?>?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(match[1]);
  }
  return targets;
}

function markdownImages(text: string): string[] {
  const targets: string[] = [];
  const pattern = /!\[(?:[^\]]|\\\])*\]\(\s*<?([^>\s)]+)(?:\s+(?:"[^"]*"|'[^']*'))?>?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    targets.push(match[1]);
  }
  return targets;
}

function markdownImageAlts(text: string): string[] {
  const alts: string[] = [];
  const pattern = /!\[((?:[^\]]|\\])*)\]\(\s*<?[^>\s)]+(?:\s+(?:"[^"]*"|'[^']*'))?>?\s*\)/g;
  for (const match of text.matchAll(pattern)) {
    alts.push(match[1] ?? "");
  }
  return alts;
}

function shouldSkipLink(target: string): boolean {
  return /^(https?:|mailto:|data:)/i.test(target) || target.startsWith("#") || target.length === 0;
}

function resolveMarkdownTarget(fromFile: string, target: string): string | undefined {
  const pathOnly = target.split("#")[0] ?? "";
  if (pathOnly.length === 0) return undefined;
  if (isAbsolute(pathOnly)) return pathOnly;
  const resolved = resolve(dirname(fromFile), pathOnly);
  const repoRoot = resolve(".");
  const relative = normalize(resolved).startsWith(repoRoot + sep) || normalize(resolved) === repoRoot;
  return relative ? resolved : undefined;
}

async function collectMarkdownFiles(roots: readonly string[]): Promise<string[]> {
  const files: string[] = [];
  for (const root of roots) {
    if (!existsSync(root)) continue;
    const info = await stat(root);
    if (info.isFile()) {
      if (root.endsWith(".md")) files.push(root);
      continue;
    }
    files.push(...await listMarkdown(root));
  }
  return files.sort();
}

async function listMarkdown(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listMarkdown(path));
    } else if (entry.isFile() && entry.name.endsWith(".md")) {
      files.push(path);
    }
  }
  return files;
}

async function collectScreenshotFiles(directory: string): Promise<string[]> {
  if (!existsSync(directory)) return [];
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectScreenshotFiles(path));
    } else if (entry.isFile() && SCREENSHOT_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(path);
    }
  }
  return files;
}
