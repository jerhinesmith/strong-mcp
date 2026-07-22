import { KG_PER_LB } from "./constants.js";

export type WeightUnit = "POUNDS" | "KILOGRAMS";

export const lbToKg = (lb: number): number => lb * KG_PER_LB;
export const kgToLb = (kg: number): number => kg / KG_PER_LB;
export const formatLb = (kg: number): number => Math.round(kgToLb(kg) * 10) / 10;
export const formatKg = (kg: number): number => Math.round(kg * 100) / 100;

export function toDisplayMeasuredValue(
  type: string,
  raw: number,
  weightUnit: WeightUnit,
): { value: number; unit: string } {
  switch (type) {
    case "WEIGHT":
      return weightUnit === "KILOGRAMS"
        ? { value: formatKg(raw), unit: "kg" }
        : { value: formatLb(raw), unit: "lb" };
    case "BODY_FAT_PERCENTAGE":
      return { value: Math.round(raw * 1000) / 10, unit: "%" };
    case "CALORIC_INTAKE":
      return { value: raw, unit: "kcal" };
    default:
      return { value: raw, unit: "" }; // open-enum passthrough on read
  }
}

export function toStoredMeasuredValue(
  type: string,
  display: number,
  weightUnit: WeightUnit,
): number {
  switch (type) {
    case "WEIGHT":
      return weightUnit === "KILOGRAMS" ? display : lbToKg(display);
    case "BODY_FAT_PERCENTAGE":
      return display / 100;
    case "CALORIC_INTAKE":
      return display;
    default:
      throw new Error(`Refusing to write unknown measurement type "${type}" (unknown value scaling)`);
  }
}
