import { describe, expect, it } from "vitest";
import { buildExerciseDefinition, buildMeasuredValue } from "../src/write/entity-builders.js";
import { makeClock } from "../src/write/ids.js";

const deps = { clock: makeClock(() => 1784685666000), weightUnit: "POUNDS" as const };

describe("buildMeasuredValue", () => {
  it("builds a flat WEIGHT value in kg", () => {
    const v = buildMeasuredValue({ type: "WEIGHT", value: 200 }, deps) as any;
    expect(v.measurementTypeValue).toBe("WEIGHT");
    expect(v.value).toBeCloseTo(90.718474, 6); // 200 lb → kg
    expect(v.isHidden).toBe(false);
    expect(v.startDate).toBe("2026-07-22T02:01:06.000Z");
    expect(v._embedded).toBeUndefined(); // flat, no nesting
  });
  it("BODY_FAT_PERCENTAGE stored as fraction", () => {
    expect((buildMeasuredValue({ type: "BODY_FAT_PERCENTAGE", value: 5 }, deps) as any).value).toBe(
      0.05,
    );
  });
  it("throws on an unknown measurement type (refuse-on-write)", () => {
    expect(() => buildMeasuredValue({ type: "MYSTERY", value: 1 }, deps)).toThrow(
      /unknown measurement type/i,
    );
  });
});

describe("buildExerciseDefinition", () => {
  it("builds a flat EXERCISE measurement with re-indexed configs and tag links", () => {
    const m = buildExerciseDefinition(
      {
        name: "Zercher Squat",
        cellTypeConfigs: [
          { cellType: "BARBELL_WEIGHT", mandatory: true },
          { cellType: "REPS", mandatory: true },
        ],
        notes: "hard",
        tagIds: ["legs"],
      },
      "u",
      deps,
    ) as any;
    expect(m.measurementType).toBe("EXERCISE");
    expect(m.name).toEqual({ custom: "Zercher Squat" });
    expect(m.instructions).toEqual({ custom: "hard" });
    expect(m.cellTypeConfigs.map((c: any) => [c.cellType, c.index])).toEqual([
      ["BARBELL_WEIGHT", 0],
      ["REPS", 1],
    ]);
    expect(m._links.tag).toEqual([{ href: "/api/users/u/tags/legs" }]);
    expect(m.isHidden).toBe(false);
  });
});
