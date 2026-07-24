import { describe, expect, it } from "vitest";
import { ReadService } from "../src/services/read-service.js";
import type { Snapshot } from "../src/types.js";

function snap(): Snapshot {
  return {
    userId: "u",
    continuation: null,
    syncedAt: null,
    preferences: {},
    entities: {
      template: { t1: { id: "t1", isHidden: false, name: { custom: "PPL" } } },
      log: {
        w1: {
          id: "w1",
          isHidden: false,
          logType: "WORKOUT",
          startDate: "2026-07-22T02:00:00Z",
          name: { custom: "Push" },
          _embedded: {
            cellSetGroup: [
              {
                id: "g1",
                _links: { measurement: { href: "/api/users/u/measurements/m1" } },
                cellSets: [
                  {
                    id: "s1",
                    isHidden: false,
                    cells: [
                      { cellType: "DUMBBELL_WEIGHT", value: "13.6077711" },
                      { cellType: "REPS", value: "12" },
                      { cellType: "RPE", value: null },
                    ],
                  },
                  { id: "s2", isHidden: false, cells: [{ cellType: "REST_TIMER", value: "85" }] },
                ],
              },
            ],
          },
        },
        wHidden: {
          id: "wHidden",
          isHidden: true,
          logType: "WORKOUT",
          name: { custom: "gone" },
          _embedded: { cellSetGroup: [] },
        },
      },
      measurement: {
        m1: {
          id: "m1",
          isHidden: false,
          measurementType: "EXERCISE",
          name: { custom: "DB Bench" },
          cellTypeConfigs: [
            { cellType: "DUMBBELL_WEIGHT", index: 0 },
            { cellType: "REPS", index: 1 },
          ],
        },
      },
      measuredValue: {
        v1: {
          id: "v1",
          isHidden: false,
          measurementTypeValue: "WEIGHT",
          value: 90.718474,
          startDate: "2026-07-22T02:02:19Z",
        },
      },
      folder: {},
      tag: {},
      metric: {},
      widget: {},
    },
  };
}

const svc = () =>
  new ReadService({ getSnapshot: snap, getWeightUnit: () => "POUNDS", userId: "u" });

describe("ReadService", () => {
  it("whoami reports unit + visible counts (hidden excluded)", () => {
    const who = svc().whoami();
    expect(who).toMatchObject({ userId: "u", weightUnit: "POUNDS" });
    expect(who.counts.log).toBe(1); // wHidden excluded
    expect(who.counts.measurement).toBe(1);
  });

  it("lists workouts excluding hidden ones", () => {
    const list = svc().listWorkouts();
    expect(list.map((w) => w.id)).toEqual(["w1"]);
    expect(list[0]).toMatchObject({ name: "Push", exerciseCount: 1 });
  });

  it("returns a workout with sets in display units (kg→lb), skipping rest timers", () => {
    const w = svc().getWorkout("w1")!;
    expect(w.exercises[0].name).toBe("DB Bench");
    expect(w.exercises[0].sets).toEqual([{ reps: 12, weight: 30, unit: "lb", rpe: null }]);
  });

  it("searches exercises by name and exposes cell types", () => {
    const ex = svc().listExercises("bench");
    expect(ex).toEqual([{ id: "m1", name: "DB Bench", cellTypes: ["DUMBBELL_WEIGHT", "REPS"] }]);
  });

  it("builds exercise history across workouts", () => {
    const hist = svc().getExerciseHistory("m1");
    expect(hist).toEqual([
      {
        workoutId: "w1",
        date: "2026-07-22T02:00:00Z",
        sets: [{ reps: 12, weight: 30, unit: "lb" }],
      },
    ]);
  });

  it("lists body measurements with type-aware display", () => {
    const m = svc().listMeasurements();
    expect(m).toEqual([
      { id: "v1", type: "WEIGHT", value: 200, unit: "lb", date: "2026-07-22T02:02:19Z" },
    ]);
  });
});
