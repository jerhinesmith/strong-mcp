import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerWriteTools } from "../src/tools/write-tools.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  const defs: Record<string, any> = {};
  return {
    handlers,
    defs,
    registerTool(name: string, def: any, handler: Function) {
      handlers[name] = handler;
      defs[name] = def;
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

  it("strong_log_workout's schema allows omitting weight (bodyweight exercises)", () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const schema = z.object(s.defs.strong_log_workout.inputSchema);
    const result = schema.safeParse({
      name: "Legs",
      exercises: [{ exerciseId: "ex", sets: [{ reps: 15, rpe: 7 }] }],
    });
    expect(result.success).toBe(true);
  });

  it("strong_log_workout's schema accepts optional startDate/endDate", () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const schema = z.object(s.defs.strong_log_workout.inputSchema);
    const result = schema.safeParse({
      name: "Legs",
      startDate: "2026-09-21T00:00:00.000Z",
      endDate: "2026-09-21T00:40:00.000Z",
      exercises: [{ exerciseId: "ex", sets: [{ reps: 12, weight: 30 }] }],
    });
    expect(result.success).toBe(true);
  });

  it("strong_log_workout forwards startDate/endDate to the service", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    await s.handlers.strong_log_workout({
      name: "Push",
      startDate: "2026-09-21T00:00:00.000Z",
      endDate: "2026-09-21T00:40:00.000Z",
      exercises: [{ exerciseId: "ex", sets: [{ reps: 5, weight: 135 }] }],
    });
    expect(service.logWorkout).toHaveBeenCalledWith(
      expect.objectContaining({
        startDate: "2026-09-21T00:00:00.000Z",
        endDate: "2026-09-21T00:40:00.000Z",
      }),
    );
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
