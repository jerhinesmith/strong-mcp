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

/** Resolve the working set an edit targets, throwing on out-of-range indices. */
function targetSet(groups: any[], edit: SetEdit): any {
  const group = groups[edit.groupIndex];
  if (!group) throw new Error(`group index ${edit.groupIndex} out of range`);
  const workingSets = (group.cellSets ?? []).filter((cs: any) => !isRestOnly(cs));
  const target = workingSets[edit.setIndex];
  if (!target) throw new Error(`working set index ${edit.setIndex} out of range`);
  return target;
}

/** The kg value we intend to store for a weight edit, honoring the display unit. */
function intendedKg(weight: number, weightUnit: WeightUnit): number {
  return weightUnit === "KILOGRAMS" ? weight : lbToKg(weight);
}

/** Which cellType a given edit field writes to (used to detect "no such cell"). */
function fieldMatches(cellType: string, field: "reps" | "rpe" | "weight"): boolean {
  if (field === "reps") return cellType === "REPS";
  if (field === "rpe") return cellType === "RPE";
  return WEIGHT_CELL_TYPES.has(cellType);
}

type EditField = "reps" | "rpe" | "weight";

/** The fields an edit intends to write, in a stable order. */
function fieldsOf(edit: SetEdit): EditField[] {
  const fields: EditField[] = [];
  if (edit.reps !== undefined) fields.push("reps");
  if (edit.rpe !== undefined) fields.push("rpe");
  if (edit.weight !== undefined) fields.push("weight");
  return fields;
}

export function editSetCells(
  entity: Entity,
  edits: SetEdit[],
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const clone = structuredClone(entity) as any;
  const groups = clone._embedded?.cellSetGroup ?? [];

  for (const edit of edits) {
    const target = targetSet(groups, edit);
    const cells: any[] = target.cells ?? [];
    const fields = fieldsOf(edit);
    if (fields.length === 0) {
      throw new Error(
        `edit at group ${edit.groupIndex}, set ${edit.setIndex} specifies no reps/weight/rpe`,
      );
    }
    // Each specified field must match a cell type in the set — otherwise the PUT
    // would silently change nothing while reporting success (finding #2).
    for (const field of fields) {
      if (!cells.some((c) => fieldMatches(c.cellType, field))) {
        throw new Error(
          `set at group ${edit.groupIndex}, index ${edit.setIndex} has no ${field.toUpperCase()} cell to edit`,
        );
      }
    }
    for (const cell of cells) {
      if (edit.reps !== undefined && cell.cellType === "REPS") cell.value = String(edit.reps);
      else if (edit.rpe !== undefined && cell.cellType === "RPE") cell.value = String(edit.rpe);
      else if (edit.weight !== undefined && WEIGHT_CELL_TYPES.has(cell.cellType)) {
        cell.value = String(intendedKg(edit.weight, deps.weightUnit));
      }
      // any cell not matched above keeps its original raw value verbatim
    }
  }
  clone.lastChanged = deps.clock();
  return clone as Entity;
}

/**
 * True iff `entity` (server truth, post-write) reflects every edit. Mirrors
 * editSetCells's navigation and cell rules exactly, so verification cannot drift
 * from the edit. In addition to matching the edited values it asserts the
 * document's structure is unchanged (same group/cellSet/cell counts) — the
 * inferred PUT re-sends the whole log, so collateral corruption of untouched
 * sets is the real risk on this path (finding #1). Weights compare numerically
 * with an epsilon (kg float storage); reps/rpe compare as strings tolerant of
 * numeric server values (finding #5). A missing entity, out-of-range index, or
 * missing target cell reads as "not confirmed" rather than throwing.
 */
export function verifySetCells(
  original: Entity | undefined,
  entity: Entity | undefined,
  edits: SetEdit[],
  deps: { weightUnit: WeightUnit },
): boolean {
  if (!entity) return false;
  const groups = (entity as any)._embedded?.cellSetGroup ?? [];
  // Structural invariance: the edit must not have added/removed groups, sets, or
  // cells relative to what we sent. Guards against a malformed inferred PUT that
  // a real server partially accepts and mangles untouched data.
  if (original && !sameShape((original as any)._embedded?.cellSetGroup ?? [], groups)) {
    return false;
  }
  for (const edit of edits) {
    let target: any;
    try {
      target = targetSet(groups, edit);
    } catch {
      return false;
    }
    const cells: any[] = target.cells ?? [];
    for (const field of fieldsOf(edit)) {
      const cell = cells.find((c) => fieldMatches(c.cellType, field));
      if (!cell) return false; // no matching cell → cannot be confirmed (finding #2)
      if (field === "weight") {
        const want = intendedKg(edit.weight as number, deps.weightUnit);
        if (Math.abs(Number(cell.value) - want) >= 1e-6) return false;
      } else {
        const want = field === "reps" ? edit.reps : edit.rpe;
        if (String(cell.value) !== String(want)) return false;
      }
    }
  }
  return true;
}

/** Same number of groups, and within each, same number of cellSets and cells. */
function sameShape(a: any[], b: any[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const sa = a[i]?.cellSets ?? [];
    const sb = b[i]?.cellSets ?? [];
    if (sa.length !== sb.length) return false;
    for (let j = 0; j < sa.length; j++) {
      if ((sa[j]?.cells ?? []).length !== (sb[j]?.cells ?? []).length) return false;
    }
  }
  return true;
}
