import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export async function writeJsonAtomic(path: string, value: unknown, mode?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  // Create the temp file with the target mode from the start so secrets are
  // never briefly world-readable between writeFile and chmod. The chmod stays
  // as belt-and-suspenders in case the file already existed with a wider mode.
  await writeFile(tmp, JSON.stringify(value, null, 2), mode !== undefined ? { mode } : "utf8");
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, path);
}
