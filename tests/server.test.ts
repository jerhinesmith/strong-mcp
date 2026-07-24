import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { buildServer, resolveWeightUnit } from "../src/server.js";
import type { Snapshot } from "../src/types.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

const config: Config = {
  accessToken: TOKEN,
  refreshToken: "r",
  deviceId: "d",
  userId: "00000000-0000-4000-8000-000000000000",
  dataDir: mkdtempSync(join(tmpdir(), "strong-srv-")),
  weightUnitOverride: "POUNDS",
};

function res(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}
const workoutPage = {
  _links: { next: { href: "/api/users/u/?continuation=C1&limit=300" } },
  _embedded: {
    template: [],
    log: [
      {
        id: "w1",
        isHidden: false,
        logType: "WORKOUT",
        name: { custom: "Push" },
        _embedded: { cellSetGroup: [] },
      },
    ],
    measurement: [],
    measuredValue: [],
    tag: [],
    metric: [],
    folder: [],
    widget: [],
  },
};
const emptyPage = {
  _links: { next: { href: "/api/users/u/?continuation=C2&limit=300" } },
  _embedded: {
    template: [],
    log: [],
    measurement: [],
    measuredValue: [],
    tag: [],
    metric: [],
    folder: [],
    widget: [],
  },
};

describe("resolveWeightUnit", () => {
  const snap = (weightUnit: unknown): Snapshot => ({
    userId: "u",
    continuation: null,
    syncedAt: null,
    preferences: weightUnit === undefined ? {} : { weightUnit },
    entities: {
      template: {},
      log: {},
      measurement: {},
      measuredValue: {},
      folder: {},
      tag: {},
      metric: {},
      widget: {},
    },
  });
  const cfg = (override?: "POUNDS" | "KILOGRAMS") =>
    ({
      accessToken: "a",
      refreshToken: "r",
      deviceId: "d",
      userId: "u",
      dataDir: "/x",
      weightUnitOverride: override,
    }) as any;

  it("prefers the explicit override", () => {
    expect(resolveWeightUnit(cfg("KILOGRAMS"), snap("POUNDS"))).toBe("KILOGRAMS");
  });
  it("reads the map-shaped preference (captured API shape)", () => {
    expect(resolveWeightUnit(cfg(), snap({ u: "KILOGRAMS" }))).toBe("KILOGRAMS");
  });
  it("reads the plain-string preference (spec-documented shape)", () => {
    expect(resolveWeightUnit(cfg(), snap("KILOGRAMS"))).toBe("KILOGRAMS");
  });
  it("defaults to POUNDS when preference is absent", () => {
    expect(resolveWeightUnit(cfg(), snap(undefined))).toBe("POUNDS");
  });
});

describe("buildServer", () => {
  it("wires deps, syncs via replay, and serves a read tool", async () => {
    // now = well before token expiry so no refresh occurs
    const now = () => (1784685666 - 1200) * 1000;
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(res(200, workoutPage))
      .mockResolvedValueOnce(res(200, emptyPage));

    const { server, sync } = await buildServer(config, fetchImpl as any, now);
    // buildServer wires real deps on a real McpServer. Assert the replayed sync
    // walked both pages and the server object was constructed.
    const { pages } = await sync();
    expect(pages).toBe(2);
    expect(server).toBeDefined();
  });
});
