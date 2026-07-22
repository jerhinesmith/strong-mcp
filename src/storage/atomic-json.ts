import { readFile, writeFile, rename, mkdir, chmod } from "node:fs/promises";
import { dirname } from "node:path";

export async function readJson<T>(path: string): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return JSON.parse(raw) as T; // throws on corrupt JSON — intentional
}

export async function writeJsonAtomic(
  path: string,
  value: unknown,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}
