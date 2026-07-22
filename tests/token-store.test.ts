import { describe, it, expect } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth/token-store.js";

describe("TokenStore", () => {
  const dir = mkdtempSync(join(tmpdir(), "strong-token-"));
  const store = new TokenStore(dir);
  const state = {
    accessToken: "a", refreshToken: "r", expiresAt: 123,
    deviceId: "d", userId: "u",
  };

  it("returns null before anything is written", async () => {
    expect(await store.read()).toBeNull();
  });
  it("persists and reads back, with 0600 perms", async () => {
    await store.write(state);
    expect(await store.read()).toEqual(state);
    const mode = statSync(join(dir, "token.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
