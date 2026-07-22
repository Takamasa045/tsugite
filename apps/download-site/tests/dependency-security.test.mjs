import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);

const EXPECTED_OVERRIDES = {
  "@babel/core": "7.29.7",
  "minimatch@3.1.5": {
    "brace-expansion": "1.1.16",
  },
  "minimatch@10.2.5": {
    "brace-expansion": "5.0.7",
  },
  "fast-uri": "3.1.4",
  "js-yaml": "4.3.0",
  "postcss": "8.5.21",
  "sharp": "0.35.3",
};

async function readJson(name) {
  return JSON.parse(await readFile(resolve(ROOT, name), "utf8"));
}

test("pins every reviewed transitive security fix in the manifest and lockfile", async () => {
  const [manifest, lockfile] = await Promise.all([
    readJson("package.json"),
    readJson("package-lock.json"),
  ]);

  assert.equal(manifest.dependencies.next, "^16.2.11");
  assert.equal(manifest.devDependencies["eslint-config-next"], "^16.2.11");
  assert.deepEqual(manifest.overrides, EXPECTED_OVERRIDES);
  assert.equal(
    manifest.scripts["security:audit"],
    "npm audit --omit=dev --audit-level=moderate && npm audit --audit-level=moderate",
  );
  assert.equal(lockfile.packages["node_modules/next"].version, "16.2.11");
  assert.equal(lockfile.packages["node_modules/@babel/core"].version, "7.29.7");
  assert.equal(
    lockfile.packages[
      "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion"
    ].version,
    "5.0.7",
  );
  assert.equal(lockfile.packages["node_modules/brace-expansion"].version, "1.1.16");
  assert.equal(lockfile.packages["node_modules/fast-uri"].version, "3.1.4");
  assert.equal(lockfile.packages["node_modules/js-yaml"].version, "4.3.0");
  assert.equal(lockfile.packages["node_modules/postcss"].version, "8.5.21");
  assert.equal(lockfile.packages["node_modules/next/node_modules/postcss"], undefined);
  assert.equal(lockfile.packages["node_modules/sharp"].version, "0.35.3");

  const sharpPlatformPackages = Object.entries(lockfile.packages).filter(
    ([path]) =>
      path.startsWith("node_modules/@img/sharp-") &&
      !path.startsWith("node_modules/@img/sharp-libvips-"),
  );
  const libvipsPackages = Object.entries(lockfile.packages).filter(([path]) =>
    path.startsWith("node_modules/@img/sharp-libvips-"),
  );
  assert.ok(sharpPlatformPackages.length >= 10);
  assert.ok(libvipsPackages.length >= 8);
  assert.ok(sharpPlatformPackages.every(([, entry]) => entry.version === "0.35.3"));
  assert.ok(libvipsPackages.every(([, entry]) => entry.version === "1.3.2"));
});

test("keeps the patched PostCSS, URI, YAML, glob, and image paths operational", async () => {
  const [{ default: postcss }, { default: sharp }, { default: fastUri }, yaml] =
    await Promise.all([
      import("postcss"),
      import("sharp"),
      import("fast-uri"),
      import("js-yaml"),
    ]);

  const maliciousCss =
    'body { content: "</style><script>alert(1)</script><style>"; }';
  const renderedCss = postcss.parse(maliciousCss).toResult().css;
  assert.doesNotMatch(renderedCss, /<\/style>/i);

  const uri = "http://evil.example\\@allowed.example";
  assert.match(fastUri.parse(uri).error ?? "", /literal backslash/i);

  assert.deepEqual(
    yaml.load("base: &base {enabled: true}\nmerged: {<<: *base, name: ok}\n"),
    {
      base: { enabled: true },
      merged: { enabled: true, name: "ok" },
    },
  );

  const braceV1 = require("brace-expansion");
  const braceV5 = require(
    resolve(
      ROOT,
      "node_modules/@typescript-eslint/typescript-estree/node_modules/brace-expansion",
    ),
  );
  assert.deepEqual(braceV1("a{},{},b"), ["a{},{},b"]);
  assert.deepEqual(braceV5.expand("a{},{},b"), ["a{},{},b"]);

  const image = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 4,
      background: { r: 1, g: 2, b: 3, alpha: 1 },
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  assert.deepEqual(
    { format: image.info.format, width: image.info.width, height: image.info.height },
    { format: "png", width: 2, height: 2 },
  );
});
