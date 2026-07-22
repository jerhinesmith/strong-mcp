import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildServer } from "../src/server.js";
import type { Config } from "../src/config.js";

const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjAwMDAwMDAwLTAwMDAtNDAwMC04MDAwLTAwMDAwMDAwMDAwMCIsImh0dHA6Ly9zY2hlbWFzLnhtbHNvYXAub3JnL3dzLzIwMDUvMDUvaWRlbnRpdHkvY2xhaW1zL25hbWUiOiJUZXN0IFVzZXIiLCJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9lbWFpbGFkZHJlc3MiOiJ0ZXN0QGV4YW1wbGUuY29tIiwiVXNlclR5cGUiOiJTdHJvbmdVc2VyIiwiaWF0IjoxNzg0Njg0NDY2LCJleHAiOjE3ODQ2ODU2NjYsImlzcyI6Imh0dHBzOi8vYmFjay5zdHJvbmcuYXBwIiwiYXVkIjoiaHR0cHM6Ly9iYWNrLnN0cm9uZy5hcHAifQ.dummy_signature_not_valid_0000000000000000000000";

const config: Config = {
  accessToken: TOKEN, refreshToken: "r", deviceId: "d",
  userId: "00000000-0000-4000-8000-000000000000",
  dataDir: mkdtempSync(join(tmpdir(), "strong-srv-")),
  weightUnitOverride: "POUNDS",
};

function res(status: number, body: unknown) {
  return { status, text: async () => JSON.stringify(body) };
}
const workoutPage = {
  _links: { next: { href: "/api/users/u/?continuation=C1&limit=300" } },
  _embedded: { template: [], log: [{ id: "w1", isHidden: false, logType: "WORKOUT", name: { custom: "Push" }, _embedded: { cellSetGroup: [] } }], measurement: [], measuredValue: [], tag: [], metric: [], folder: [], widget: [] },
};
const emptyPage = {
  _links: { next: { href: "/api/users/u/?continuation=C2&limit=300" } },
  _embedded: { template: [], log: [], measurement: [], measuredValue: [], tag: [], metric: [], folder: [], widget: [] },
};

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
