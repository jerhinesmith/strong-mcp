import { describe, expect, it, vi } from "vitest";
import { registerWriteTools } from "../src/tools/write-tools.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return {
    handlers,
    registerTool(name: string, _def: unknown, handler: Function) {
      handlers[name] = handler;
    },
  };
}

const service = {
  logWorkout: vi.fn(async () => ({ id: "w1", name: "Push", exercises: 1 })),
  deleteWorkout: vi.fn(async () => ({ id: "w1", deleted: true })),
  createTemplate: vi.fn(async () => ({ id: "t1", name: "PPL" })),
  updateTemplateName: vi.fn(async () => ({ id: "t1" })),
  deleteTemplate: vi.fn(async () => ({ id: "t1", deleted: true })),
  logMeasurement: vi.fn(async () => ({ id: "v1", type: "WEIGHT" })),
  createExercise: vi.fn(async () => ({ id: "m1", name: "X" })),
  updateExerciseName: vi.fn(async () => ({ id: "m1" })),
  archiveExercise: vi.fn(async () => ({ id: "m1", archived: true })),
  updateWorkoutSets: vi.fn(async () => ({ id: "w1", serverConfirmed: true })),
  deleteMeasurement: vi.fn(async () => ({ id: "v1", deleted: true, serverConfirmed: true })),
} as any;

describe("registerWriteTools", () => {
  it("registers all 11 write tools", () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    expect(Object.keys(s.handlers).sort()).toEqual(
      [
        "strong_archive_exercise",
        "strong_create_exercise",
        "strong_create_template",
        "strong_delete_measurement",
        "strong_delete_template",
        "strong_delete_workout",
        "strong_log_measurement",
        "strong_log_workout",
        "strong_update_exercise",
        "strong_update_template",
        "strong_update_workout",
      ].sort(),
    );
  });

  it("strong_log_workout forwards args and returns text content", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const out = await s.handlers.strong_log_workout({
      name: "Push",
      exercises: [{ exerciseId: "ex", sets: [{ reps: 5, weight: 135 }] }],
    });
    expect(service.logWorkout).toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toEqual({ id: "w1", name: "Push", exercises: 1 });
  });

  it("strong_update_workout forwards id + edits and returns serverConfirmed", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const out = await s.handlers.strong_update_workout({
      id: "w1",
      edits: [{ groupIndex: 0, setIndex: 0, reps: 8 }],
    });
    expect(service.updateWorkoutSets).toHaveBeenCalledWith("w1", [
      { groupIndex: 0, setIndex: 0, reps: 8 },
    ]);
    expect(JSON.parse(out.content[0].text)).toEqual({ id: "w1", serverConfirmed: true });
  });

  it("strong_delete_measurement forwards id and returns serverConfirmed", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const out = await s.handlers.strong_delete_measurement({ id: "v1" });
    expect(service.deleteMeasurement).toHaveBeenCalledWith("v1");
    expect(JSON.parse(out.content[0].text)).toEqual({
      id: "v1",
      deleted: true,
      serverConfirmed: true,
    });
  });
});
