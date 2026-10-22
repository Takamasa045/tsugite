// Copies the repository story catalog into the v2 package and writes NOTICE.
// Run from the repository: node v2/scripts/sync-story-catalog.mjs
// The catalog bytes stay identical. NOTICE is regenerated from those bytes
// and the package license. Tests fail when either copy drifts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

const v2Root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(v2Root, '..');

export const storyCatalogPaths = {
  canonical: path.join(repoRoot, 'knowledge', 'story-frameworks', 'catalog.yaml'),
  bundled: path.join(v2Root, 'knowledge', 'story-frameworks', 'catalog.yaml'),
  notice: path.join(v2Root, 'knowledge', 'story-frameworks', 'NOTICE.md'),
  license: path.join(v2Root, 'LICENSE')
};

export function storyCatalogNotice(catalogText, licenseText) {
  const catalog = parse(catalogText, { maxAliasCount: 0 });
  if (!catalog || !Array.isArray(catalog.sources) || catalog.sources.length === 0) {
    throw new Error('Story catalog has no sources to attribute');
  }
  const sources = catalog.sources.map(source => {
    for (const field of ['id', 'title', 'publisher', 'url', 'accessed_at']) {
      if (typeof source?.[field] !== 'string' || !source[field]) throw new Error(`Story source is missing ${field}`);
    }
    return `- ${source.id}: ${source.title} (${source.publisher}) ${source.url} accessed ${source.accessed_at}`;
  });
  const license = String(licenseText).trimEnd();
  if (!license.includes('MIT License') || !license.includes('Permission is hereby granted')) {
    throw new Error('Package license is not the expected MIT text');
  }
  return [
    '# Story framework catalog',
    '',
    '`catalog.yaml` is read-only planning data shipped inside the Tsugite v2 package.',
    '`plugin story consult` reads this file. It does not search parent directories.',
    '',
    'この `catalog.yaml` は、リポジトリの `knowledge/story-frameworks/catalog.yaml` と同じバイトです。',
    '物語相談はこの同梱ファイルだけを読みます。引用先の本文は同梱していません。',
    '`source_ids` が空の項目は、出典がない記録のままです。空欄を出典ありとは扱いません。',
    '',
    'The file is covered by the MIT license at the end of this notice.',
    'Cited pages are not reproduced. Entries record structural roles and point at those pages.',
    'An empty `source_ids` list means the catalog recorded no citation for that item.',
    '',
    '## Sources',
    '',
    ...sources,
    '',
    '## License',
    '',
    license,
    ''
  ].join('\n');
}

export async function writeStoryCatalogPackage() {
  const catalog = await fs.readFile(storyCatalogPaths.canonical);
  const license = await fs.readFile(storyCatalogPaths.license, 'utf8');
  await fs.mkdir(path.dirname(storyCatalogPaths.bundled), { recursive: true });
  await fs.writeFile(storyCatalogPaths.bundled, catalog);
  await fs.writeFile(storyCatalogPaths.notice, storyCatalogNotice(catalog.toString('utf8'), license));
  const shipped = await fs.readFile(storyCatalogPaths.bundled);
  if (!shipped.equals(catalog)) throw new Error('Shipped story catalog differs from the repository catalog');
  return storyCatalogPaths;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const written = await writeStoryCatalogPackage();
  process.stdout.write(`wrote ${path.relative(repoRoot, written.bundled)}\nwrote ${path.relative(repoRoot, written.notice)}\n`);
}
