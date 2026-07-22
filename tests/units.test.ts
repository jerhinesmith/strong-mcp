import { describe, it, expect } from "vitest";
import { lbToKg, kgToLb, formatLb, toDisplayMeasuredValue } from "../src/units.js";

describe("weight conversion", () => {
  it("converts lb → kg exactly as captured", () => {
    expect(lbToKg(10)).toBeCloseTo(4.5359237, 7);
    expect(lbToKg(30)).toBeCloseTo(13.6077711, 7);
    expect(lbToKg(200)).toBeCloseTo(90.718474, 6);
  });
  it("round-trips kg → lb", () => {
    expect(kgToLb(13.6077711)).toBeCloseTo(30, 6);
    expect(formatLb(90.718474)).toBe(200);
  });
});

describe("measuredValue display", () => {
  it("WEIGHT is kg→lb", () => {
    expect(toDisplayMeasuredValue("WEIGHT", 90.718474, "POUNDS")).toEqual({ value: 200, unit: "lb" });
  });
  it("BODY_FAT_PERCENTAGE is a fraction → percent", () => {
    expect(toDisplayMeasuredValue("BODY_FAT_PERCENTAGE", 0.05, "POUNDS")).toEqual({ value: 5, unit: "%" });
  });
  it("CALORIC_INTAKE passes through", () => {
    expect(toDisplayMeasuredValue("CALORIC_INTAKE", 2200, "POUNDS")).toEqual({ value: 2200, unit: "kcal" });
  });
  it("unknown type passes raw through on read", () => {
    expect(toDisplayMeasuredValue("MYSTERY", 42, "POUNDS")).toEqual({ value: 42, unit: "" });
  });
});
