export function toPortablePath(path: string): string {
  return path.replaceAll("\\", "/");
}
