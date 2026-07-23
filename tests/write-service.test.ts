import { describe, it, expect, vi } from "vitest";
import { WriteService } from "../src/services/write-service.js";
import { WriteEngine } from "../src/write/write-engine.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const exDef = JSON.parse(readFileSync(join(here, "fixtures", "exercise-def-barbell.json"), "utf8"));

function makeSnap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null,
    preferences: { restTimer: { u: 85 } },
    entities: {
      template: {}, log: {}, measurement: { "ex-barbell": exDef }, measuredValue: {},
      folder: { "u-my-templates": { id: "u-my-templates", isHidden: false, _links: { template: [] } } },
      tag: {}, metric: {}, widget: {},
    },
  };
}

function makeService() {
  const snapshot = makeSnap();
  const put = vi.fn(async () => {});
  const engine = new WriteEngine({
    userId: "u",
    refresh: async () => snapshot,
    put,
    persist: async () => {},
  });
  const service = new WriteService({ engine, getWeightUnit: () => "POUNDS", clock: makeClock(() => 1784685666000), userId: "u" });
  return { service, snapshot, put };
}

describe("WriteService.logWorkout", () => {
  it("logs a workout into _embedded.log and applies it to the snapshot", async () => {
    const { service, snapshot, put } = makeService();
    const res = await service.logWorkout({ name: "Push", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] });
    expect(res.name).toBe("Push");
    const env = put.mock.calls[0][0];
    expect(env._embedded.log).toHaveLength(1);
    expect(env._embedded.log[0].logType).toBe("WORKOUT");
    expect(Object.keys(snapshot.entities.log)).toContain(res.id);
  });
});

describe("WriteService.createTemplate + deleteTemplate", () => {
  it("createTemplate writes template + updated folder link", async () => {
    const { service, put } = makeService();
    const res = await service.createTemplate({ name: "PPL", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] });
    const env = put.mock.calls[0][0];
    expect(env._embedded.template[0].id).toBe(res.id);
    expect(env._embedded.folder[0]._links.template.some((l: any) => l.href.endsWith(`/templates/${res.id}`))).toBe(true);
  });

  it("deleteTemplate soft-deletes and unlinks from its folder", async () => {
    const { service, snapshot, put } = makeService();
    // seed a template + folder link
    snapshot.entities.template["t1"] = { id: "t1", logType: "TEMPLATE", isHidden: false, _embedded: { cellSetGroup: [] } };
    snapshot.entities.folder["u-my-templates"]._links = { template: [{ href: "/api/users/u/templates/t1" }] };
    const res = await service.deleteTemplate("t1");
    expect(res.deleted).toBe(true);
    const env = put.mock.calls[0][0];
    expect(env._embedded.template[0].isHidden).toBe(true);
    expect(env._embedded.folder[0]._links.template).toEqual([]);
  });
});

describe("WriteService.logMeasurement / archiveExercise", () => {
  it("logs a body measurement", async () => {
    const { service, put } = makeService();
    await service.logMeasurement({ type: "WEIGHT", value: 200 });
    expect(put.mock.calls[0][0]._embedded.measuredValue[0].measurementTypeValue).toBe("WEIGHT");
  });
  it("refuses an unknown measurement type", async () => {
    const { service } = makeService();
    await expect(service.logMeasurement({ type: "MYSTERY", value: 1 })).rejects.toThrow(/unknown measurement type/i);
  });
  it("archiveExercise flips isHidden on the measurement", async () => {
    const { service, snapshot, put } = makeService();
    const res = await service.archiveExercise("ex-barbell");
    expect(res.archived).toBe(true);
    expect(put.mock.calls[0][0]._embedded.measurement[0].isHidden).toBe(true);
    void snapshot;
  });
});
