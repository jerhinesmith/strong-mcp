import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

const base = {
  STRONG_ACCESS_TOKEN: TOKEN,
  STRONG_REFRESH_TOKEN: "refresh-abc",
  STRONG_DEVICE_ID: "11111111-1111-4111-8111-111111111111",
};

describe("loadConfig", () => {
  it("builds a token seed from a full token env triple and defaults dataDir", () => {
    const cfg = loadConfig({ ...base, HOME: "/home/j" } as NodeJS.ProcessEnv);
    expect(cfg.dataDir).toBe("/home/j/.strong-mcp");
    expect(cfg.seed).toEqual({
      accessToken: TOKEN,
      refreshToken: "refresh-abc",
      deviceId: base.STRONG_DEVICE_ID,
    });
  });
  it("has no seed when token env vars are absent (login-command path)", () => {
    const cfg = loadConfig({ HOME: "/home/j" } as NodeJS.ProcessEnv);
    expect(cfg.seed).toBeUndefined();
    expect(cfg.dataDir).toBe("/home/j/.strong-mcp");
  });
  it("ignores a partial seed (all three token vars required together)", () => {
    const cfg = loadConfig({
      STRONG_ACCESS_TOKEN: TOKEN,
      STRONG_REFRESH_TOKEN: "refresh-abc",
      HOME: "/home/j",
    } as NodeJS.ProcessEnv); // missing STRONG_DEVICE_ID
    expect(cfg.seed).toBeUndefined();
  });
  it("honors STRONG_DATA_DIR and weight unit override", () => {
    const cfg = loadConfig({
      ...base,
      STRONG_DATA_DIR: "/data",
      STRONG_WEIGHT_UNIT: "KILOGRAMS",
    } as NodeJS.ProcessEnv);
    expect(cfg.dataDir).toBe("/data");
    expect(cfg.weightUnitOverride).toBe("KILOGRAMS");
  });
  it("treats empty-string optional vars as absent (golden-path .env copy)", () => {
    const cfg = loadConfig({
      ...base,
      HOME: "/home/j",
      STRONG_DATA_DIR: "",
      STRONG_PROXY_URL: "",
      STRONG_WEIGHT_UNIT: "",
    } as NodeJS.ProcessEnv);
    expect(cfg.dataDir).toBe("/home/j/.strong-mcp");
    expect(cfg.proxyUrl).toBeUndefined();
    expect(cfg.weightUnitOverride).toBeUndefined();
  });
});
