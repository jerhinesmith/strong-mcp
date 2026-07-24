import type { Entity } from "../types.js";
import { toStoredMeasuredValue, type WeightUnit } from "../units.js";
import { type Clock, newId } from "./ids.js";

export function buildMeasuredValue(
  input: { type: string; value: number },
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const ts = deps.clock();
  return {
    id: newId(),
    measurementTypeValue: input.type,
    value: toStoredMeasuredValue(input.type, input.value, deps.weightUnit),
    startDate: ts,
    created: ts,
    lastChanged: ts,
    isHidden: false,
  } as unknown as Entity;
}

export function buildExerciseDefinition(
  input: {
    name: string;
    cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[];
    notes?: string;
    tagIds?: string[];
  },
  userId: string,
  deps: { clock: Clock },
): Entity {
  const ts = deps.clock();
  return {
    id: newId(),
    measurementType: "EXERCISE",
    name: { custom: input.name },
    instructions: { custom: input.notes ?? "" },
    notes: null,
    isGlobal: false,
    isHidden: false,
    tools: [],
    cellTypeConfigs: input.cellTypeConfigs.map((c, index) => ({
      cellType: c.cellType,
      mandatory: c.mandatory ?? false,
      isExponent: c.isExponent ?? false,
      index,
    })),
    _links: { tag: (input.tagIds ?? []).map((t) => ({ href: `/api/users/${userId}/tags/${t}` })) },
    created: ts,
    lastChanged: ts,
  } as unknown as Entity;
}
