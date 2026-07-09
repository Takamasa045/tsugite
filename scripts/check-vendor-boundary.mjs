import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const targets = ["src", "manifest", "SKILL.md"];
const bannedTerms = await adapterNames("adapters");

const files = (await Promise.all(targets.map((target) => collectFiles(target)))).flat();
const violations = [];

for (const file of files) {
  const text = await readFile(file, "utf8");
  const lower = text.toLowerCase();
  for (const term of bannedTerms) {
    if (lower.includes(term)) {
      violations.push(`${file}: contains ${term}`);
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join("\n"));
  process.exit(1);
}

console.log("vendor boundary ok");

async function collectFiles(path) {
  const current = await stat(path);
  if (current.isFile()) return [path];
  if (!current.isDirectory()) return [];

  const children = await readdir(path);
  return (await Promise.all(children.map((child) => collectFiles(join(path, child))))).flat();
}

async function adapterNames(path) {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name.toLowerCase());
  } catch {
    return [];
  }
}
