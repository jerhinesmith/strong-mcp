import { describe, it, expect, vi } from "vitest";
import { registerWriteTools } from "../src/tools/write-tools.js";

function fakeServer() {
  const handlers: Record<string, Function> = {};
  return { handlers, registerTool(name: string, _def: unknown, handler: Function) { handlers[name] = handler; } };
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
} as any;

describe("registerWriteTools", () => {
  it("registers all 9 captured write tools", () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    expect(Object.keys(s.handlers).sort()).toEqual([
      "strong_archive_exercise", "strong_create_exercise", "strong_create_template",
      "strong_delete_template", "strong_delete_workout", "strong_log_measurement",
      "strong_log_workout", "strong_update_exercise", "strong_update_template",
    ].sort());
  });

  it("strong_log_workout forwards args and returns text content", async () => {
    const s = fakeServer();
    registerWriteTools(s as any, service);
    const out = await s.handlers["strong_log_workout"]({ name: "Push", exercises: [{ exerciseId: "ex", sets: [{ reps: 5, weight: 135 }] }] });
    expect(service.logWorkout).toHaveBeenCalled();
    expect(JSON.parse(out.content[0].text)).toEqual({ id: "w1", name: "Push", exercises: 1 });
  });
});
