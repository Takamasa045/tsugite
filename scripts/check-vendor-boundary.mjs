import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const targets = ["src", "manifest", ".agents/skills/tsugite/SKILL.md"];
/**
 * Core IR / compiler contract tokens that intentionally appear in neutral core.
 * Directory names under adapters/ or knowledge/ may coincide with these ids;
 * they must not force core to invent a different IR model identifier.
 * Built without a literal banned token so this script stays self-clean.
 */
const CORE_CONTRACT_ALLOWLIST = new Set([["mini", "max", "-", "h3"].join("")]);
const bannedTerms = (await vendorNames(["adapters", "backends", "knowledge/video-models"]))
  .filter((term) => !CORE_CONTRACT_ALLOWLIST.has(term));

const files = (await Promise.all(targets.map((target) => collectFiles(target)))).flat();
const violations = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const lower = text.toLowerCase();
  for (const term of bannedTerms) {
    if (containsVendorTerm(lower, term)) {
      violations.push(`${file}: contains ${term}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("vendor boundary ok");

/**
 * Whole-token match so adapter id "minimax" does not false-positive on IR id "minimax-h3".
 * Hyphen is treated as part of the token alphabet.
 */
function containsVendorTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![a-z0-9-])${escaped}(?![a-z0-9-])`, "i").test(text);
}

async function collectFiles(path) {
  const current = await stat(path);
  if (current.isFile()) return [path];
  if (!current.isDirectory()) return [];

  const children = await readdir(path);
  return (await Promise.all(children.map((child) => collectFiles(join(path, child))))).flat();
}

async function vendorNames(paths) {
  const names = await Promise.all(paths.map((path) => childDirectoryNames(path)));
  return [...new Set(names.flat())];
}

async function childDirectoryNames(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase());
  } catch {
    return [];
  }
}
