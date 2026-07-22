import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore } from "../src/auth/token-store.js";
import { TokenManager } from "../src/auth/token-manager.js";

const TOKEN_EXP_1784685666 =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

function makeManager(refreshFn: any, now: () => number) {
  const dir = mkdtempSync(join(tmpdir(), "strong-tm-"));
  const store = new TokenStore(dir);
  return new TokenManager({
    store, refreshFn, now,
    seed: { accessToken: TOKEN_EXP_1784685666, refreshToken: "r0", deviceId: "d", userId: "u" },
  });
}

describe("TokenManager", () => {
  it("returns the seeded access token when not near expiry", async () => {
    // now = 20 min before the token's exp
    const now = () => (1784685666 - 1200) * 1000;
    const refreshFn = vi.fn();
    const tm = makeManager(refreshFn, now);
    expect(await tm.getAccessToken()).toBe(TOKEN_EXP_1784685666);
    expect(refreshFn).not.toHaveBeenCalled();
  });

  it("refreshes when within the skew window and persists the rotated token", async () => {
    const now = () => 1784685666 * 1000 - 30_000; // 30s before exp (< 60s skew)
    const refreshFn = vi.fn().mockResolvedValue({
      accessToken: TOKEN_EXP_1784685666, refreshToken: "r1-rotated", expiresIn: 1200,
    });
    const tm = makeManager(refreshFn, now);
    await tm.getAccessToken();
    expect(refreshFn).toHaveBeenCalledTimes(1);
    // second refresh must send the ROTATED token, not the seed
    await tm.forceRefresh();
    expect(refreshFn.mock.calls[1][0].refreshToken).toBe("r1-rotated");
  });

  it("coalesces concurrent forceRefresh into a single call (single-flight)", async () => {
    const now = () => 1784685666 * 1000 - 30_000;
    let resolve!: (v: any) => void;
    const refreshFn = vi.fn().mockImplementation(
      () => new Promise((r) => { resolve = r; }),
    );
    const tm = makeManager(refreshFn, now);
    const p1 = tm.forceRefresh();
    const p2 = tm.forceRefresh();
    // wait for refreshFn to be called
    await vi.waitUntil(() => refreshFn.mock.calls.length > 0);
    resolve({ accessToken: TOKEN_EXP_1784685666, refreshToken: "r1", expiresIn: 1200 });
    await Promise.all([p1, p2]);
    expect(refreshFn).toHaveBeenCalledTimes(1);
  });

  it("fails loudly when refresh rejects (re-seed required)", async () => {
    const now = () => 1784685666 * 1000 - 30_000;
    const refreshFn = vi.fn().mockRejectedValue(new Error("401"));
    const tm = makeManager(refreshFn, now);
    await expect(tm.forceRefresh()).rejects.toThrow(/re-seed/i);
  });
});
