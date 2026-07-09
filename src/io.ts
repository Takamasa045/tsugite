import { readFile } from "node:fs/promises";
import { parse } from "yaml";

export async function readTextFile(path: string): Promise<string> {
  return readFile(path, "utf8");
}

export async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readTextFile(path));
}

export async function readYamlFile(path: string): Promise<unknown> {
  return parse(await readTextFile(path));
}
