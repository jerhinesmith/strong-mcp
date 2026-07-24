import type { Entity } from "../types.js";
import { lbToKg, type WeightUnit } from "../units.js";
import type { Clock } from "./ids.js";

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT",
  "BARBELL_WEIGHT",
  "WEIGHTED_BODYWEIGHT",
  "WEIGHT",
]);

export function editEntityName(entity: Entity, name: string, clock: Clock): Entity {
  const clone = structuredClone(entity) as any;
  clone.name = { ...(clone.name ?? {}), custom: name };
  clone.lastChanged = clock();
  return clone as Entity;
}

interface SetEdit {
  groupIndex: number;
  setIndex: number;
  reps?: number;
  weight?: number;
  rpe?: number;
}

function isRestOnly(cellSet: any): boolean {
  const cells = Array.isArray(cellSet?.cells) ? cellSet.cells : [];
  return cells.length > 0 && cells.every((c: any) => c.cellType === "REST_TIMER");
}

export function editSetCells(
  entity: Entity,
  edits: SetEdit[],
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const clone = structuredClone(entity) as any;
  const groups = clone._embedded?.cellSetGroup ?? [];

  for (const edit of edits) {
    const group = groups[edit.groupIndex];
    if (!group) throw new Error(`group index ${edit.groupIndex} out of range`);
    const workingSets = (group.cellSets ?? []).filter((cs: any) => !isRestOnly(cs));
    const target = workingSets[edit.setIndex];
    if (!target) throw new Error(`working set index ${edit.setIndex} out of range`);

    for (const cell of target.cells ?? []) {
      if (edit.reps !== undefined && cell.cellType === "REPS") cell.value = String(edit.reps);
      else if (edit.rpe !== undefined && cell.cellType === "RPE") cell.value = String(edit.rpe);
      else if (edit.weight !== undefined && WEIGHT_CELL_TYPES.has(cell.cellType)) {
        cell.value = String(deps.weightUnit === "KILOGRAMS" ? edit.weight : lbToKg(edit.weight));
      }
      // any cell not matched above keeps its original raw value verbatim
    }
  }
  clone.lastChanged = deps.clock();
  return clone as Entity;
}

/**
 * True iff `entity` (server truth, post-write) already reflects every edit.
 * Mirrors editSetCells exactly, reusing the same navigation and cell rules, so
 * verification cannot drift from the edit. Weights compared numerically with a
 * small epsilon (values are stored as stringified kg floats). A missing entity
 * or out-of-range index reads as "not confirmed" rather than throwing.
 */
export function verifySetCells(
  entity: Entity | undefined,
  edits: SetEdit[],
  deps: { weightUnit: WeightUnit },
): boolean {
  if (!entity) return false;
  const groups = (entity as any)._embedded?.cellSetGroup ?? [];
  for (const edit of edits) {
    const group = groups[edit.groupIndex];
    if (!group) return false;
    const workingSets = (group.cellSets ?? []).filter((cs: any) => !isRestOnly(cs));
    const target = workingSets[edit.setIndex];
    if (!target) return false;
    for (const cell of target.cells ?? []) {
      if (edit.reps !== undefined && cell.cellType === "REPS") {
        if (cell.value !== String(edit.reps)) return false;
      } else if (edit.rpe !== undefined && cell.cellType === "RPE") {
        if (cell.value !== String(edit.rpe)) return false;
      } else if (edit.weight !== undefined && WEIGHT_CELL_TYPES.has(cell.cellType)) {
        const want = deps.weightUnit === "KILOGRAMS" ? edit.weight : lbToKg(edit.weight);
        if (Math.abs(Number(cell.value) - want) >= 1e-6) return false;
      }
    }
  }
  return true;
}
