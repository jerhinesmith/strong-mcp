import { describe, expect, it, vi } from "vitest";
import { registerReadTools } from "../src/tools/read-tools.js";

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
  whoami: vi.fn(() => ({ userId: "u", weightUnit: "POUNDS", syncedAt: null, counts: {} })),
  listWorkouts: vi.fn(() => [{ id: "w1", name: "Push", exerciseCount: 1 }]),
  getWorkout: vi.fn(() => ({ id: "w1", name: "Push", exercises: [] })),
  listTemplates: vi.fn(() => []),
  listExercises: vi.fn(() => [{ id: "m1", name: "Bench", cellTypes: [] }]),
  getExerciseHistory: vi.fn(() => []),
  listMeasurements: vi.fn(() => []),
} as any;

describe("registerReadTools", () => {
  it("registers all read tools", () => {
    const server = fakeServer();
    registerReadTools(server as any, { service, sync: vi.fn(async () => ({ pages: 1 })) });
    expect(Object.keys(server.handlers).sort()).toEqual(
      [
        "strong_get_exercise_history",
        "strong_get_workout",
        "strong_list_exercises",
        "strong_list_measurements",
        "strong_list_templates",
        "strong_list_workouts",
        "strong_sync",
        "strong_whoami",
      ].sort(),
    );
  });

  it("strong_list_workouts returns service data as text content", async () => {
    const server = fakeServer();
    registerReadTools(server as any, { service, sync: vi.fn(async () => ({ pages: 1 })) });
    const out = await server.handlers.strong_list_workouts({});
    expect(out.content[0].type).toBe("text");
    expect(JSON.parse(out.content[0].text)).toEqual([{ id: "w1", name: "Push", exerciseCount: 1 }]);
  });

  it("strong_sync triggers a sync and reports page count", async () => {
    const server = fakeServer();
    const sync = vi.fn(async () => ({ pages: 3 }));
    registerReadTools(server as any, { service, sync });
    const out = await server.handlers.strong_sync({});
    expect(sync).toHaveBeenCalled();
    expect(out.content[0].text).toContain("3");
  });
});
