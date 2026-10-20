/** Skip counts for global argv tokens that may appear before the command. */
export function langOptionSpan(argv: readonly string[], index: number): number {
  if (argv[index] !== "--lang") return 0;
  const value = argv[index + 1];
  return value && !value.startsWith("-") ? 2 : 1;
}

export function nextNonGlobalIndex(argv: readonly string[], start = 0): number {
  for (let index = start; index < argv.length; index += 1) {
    if (argv[index] === "--json") continue;
    const span = langOptionSpan(argv, index);
    if (span > 0) {
      index += span - 1;
      continue;
    }
    return index;
  }
  return -1;
}
