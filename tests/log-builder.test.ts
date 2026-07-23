import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { buildLog, restSeconds } from "../src/write/log-builder.js";
import { makeClock } from "../src/write/ids.js";
import type { Snapshot } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const exDef = JSON.parse(readFileSync(join(here, "fixtures", "exercise-def-barbell.json"), "utf8"));

function snap(): Snapshot {
  return {
    userId: "u", continuation: null, syncedAt: null,
    preferences: { restTimer: { u: 90, "ex-barbell": 120 } },
    entities: {
      template: {}, log: {}, measurement: { "ex-barbell": exDef },
      measuredValue: {}, folder: {}, tag: {}, metric: {}, widget: {},
    },
  };
}
const deps = { clock: makeClock(() => 1784685666000), weightUnit: "POUNDS" as const };

describe("buildLog (WORKOUT)", () => {
  it("emits a workout with cellTypeConfig-ordered cells and alternating rest timers", () => {
    const log = buildLog("WORKOUT",
      { name: "Push", templateId: "t1", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }, { reps: 5, weight: 135, rpe: 8 }] }] },
      snap(), deps) as any;

    expect(log.logType).toBe("WORKOUT");
    expect(log.name).toEqual({ custom: "Push" });
    expect(log.startDate).toBe("2026-07-22T02:01:06.000Z");
    expect(log.endDate).toBe("2026-07-22T02:01:06.000Z");
    expect(log._links.template.href).toContain("/templates/t1");

    const group = log._embedded.cellSetGroup[0];
    expect(group._links.measurement.href).toContain("/measurements/ex-barbell");
    // 2 working sets + 2 rest timers, strictly alternating
    expect(group.cellSets).toHaveLength(4);
    const [set1, rest1, set2, rest2] = group.cellSets;

    // cells follow config order: BARBELL_WEIGHT, REPS, RPE
    expect(set1.cells.map((c: any) => c.cellType)).toEqual(["BARBELL_WEIGHT", "REPS", "RPE"]);
    expect(set1.isCompleted).toBe(true);
    // 135 lb → kg
    expect(Number(set1.cells[0].value)).toBeCloseTo(135 * 0.45359237, 6);
    expect(set1.cells[1].value).toBe("5");
    expect(set1.cells[2].value).toBeNull(); // rpe omitted → null

    expect(set2.cells[2].value).toBe("8"); // rpe provided

    // rest timers: single REST_TIMER cell, exercise-specific 120s
    expect(rest1.cells).toHaveLength(1);
    expect(rest1.cells[0].cellType).toBe("REST_TIMER");
    expect(rest1.cells[0].value).toBe("120");
    expect(rest2.cells[0].value).toBe("120");
  });

  it("throws when the referenced exercise id is not in the snapshot", () => {
    expect(() =>
      buildLog("WORKOUT", { name: "x", exercises: [{ exerciseId: "missing", sets: [{ reps: 1, weight: 1 }] }] }, snap(), deps),
    ).toThrow(/missing/);
  });

  it("throws (refuse rule) when a cellTypeConfig has an unknown cell type", () => {
    const s = snap();
    s.entities.measurement["ex-weird"] = {
      id: "ex-weird", isHidden: false, measurementType: "EXERCISE",
      name: { custom: "Weird" },
      cellTypeConfigs: [{ cellType: "DISTANCE", mandatory: true, index: 0 }],
    } as any;
    expect(() =>
      buildLog("WORKOUT", { name: "x", exercises: [{ exerciseId: "ex-weird", sets: [{ reps: 1, weight: 1 }] }] }, s, deps),
    ).toThrow(/unknown cell type|DISTANCE|Refusing/i);
  });

  it("emits cells in cellTypeConfig index order even when configs are given out of order", () => {
    const s = snap();
    s.entities.measurement["ex-unordered"] = {
      id: "ex-unordered", isHidden: false, measurementType: "EXERCISE",
      name: { custom: "Unordered" },
      cellTypeConfigs: [
        { cellType: "REPS", index: 1 },
        { cellType: "BARBELL_WEIGHT", index: 0 },
      ],
    } as any;
    const log = buildLog("WORKOUT", { name: "x", exercises: [{ exerciseId: "ex-unordered", sets: [{ reps: 5, weight: 100 }] }] }, s, deps) as any;
    const cells = log._embedded.cellSetGroup[0].cellSets[0].cells;
    expect(cells.map((c: any) => c.cellType)).toEqual(["BARBELL_WEIGHT", "REPS"]);
  });

  it("passes weight through unconverted when weightUnit is KILOGRAMS", () => {
    const kgDeps = { clock: makeClock(() => 1784685666000), weightUnit: "KILOGRAMS" as const };
    const log = buildLog("WORKOUT", { name: "x", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 100 }] }] }, snap(), kgDeps) as any;
    const weightCell = log._embedded.cellSetGroup[0].cellSets[0].cells[0];
    expect(Number(weightCell.value)).toBe(100);
  });
});

describe("buildLog (TEMPLATE)", () => {
  it("has no start/end date and sets are not completed", () => {
    const t = buildLog("TEMPLATE", { name: "PPL", exercises: [{ exerciseId: "ex-barbell", sets: [{ reps: 5, weight: 135 }] }] }, snap(), deps) as any;
    expect(t.logType).toBe("TEMPLATE");
    expect(t.startDate).toBeUndefined();
    expect(t._embedded.cellSetGroup[0].cellSets[0].isCompleted).toBe(false);
  });
});

describe("restSeconds", () => {
  it("prefers exercise-specific, then user default, then 85", () => {
    expect(restSeconds(snap(), "ex-barbell")).toBe("120");
    expect(restSeconds(snap(), "other")).toBe("90");
    const s = snap(); s.preferences = {};
    expect(restSeconds(s, "x")).toBe("85");
  });
});
