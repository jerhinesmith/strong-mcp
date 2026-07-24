import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJsonAtomic } from "../src/storage/atomic-json.js";

describe("atomic-json", () => {
  const dir = mkdtempSync(join(tmpdir(), "strong-atomic-"));

  it("returns null for a missing file", async () => {
    expect(await readJson(join(dir, "nope.json"))).toBeNull();
  });
  it("round-trips through write-then-rename", async () => {
    const p = join(dir, "sub", "data.json");
    await writeJsonAtomic(p, { a: 1 });
    expect(await readJson<{ a: number }>(p)).toEqual({ a: 1 });
  });
  it("throws on corrupt JSON", async () => {
    const p = join(dir, "bad.json");
    const { writeFileSync } = await import("node:fs");
    writeFileSync(p, "{not json");
    await expect(readJson(p)).rejects.toThrow();
  });
});
