import { WEIGHT_CELL_TYPES } from "../constants.js";
import type { Entity, Snapshot } from "../types.js";
import { lbToKg, type WeightUnit } from "../units.js";
import { type Clock, newId } from "./ids.js";

export interface SetInput {
  /** Omit on a TEMPLATE to leave the cell blank; required on a WORKOUT for REPS exercises. */
  reps?: number;
  /** Omit for exercises with no weight cell type (e.g. bodyweight movements), or on a TEMPLATE to leave it blank. */
  weight?: number;
  rpe?: number;
  /** Seconds, for DURATION exercises (planks, hangs). Omit on a TEMPLATE to leave it blank. */
  seconds?: number;
}
export interface ExerciseInput {
  exerciseId: string;
  sets: SetInput[];
}
export interface BuildLogInput {
  name: string;
  templateId?: string;
  exercises: ExerciseInput[];
  /** ISO timestamps for a WORKOUT log; default to "now" (both) when omitted. */
  startDate?: string;
  endDate?: string;
}

export function restSeconds(snapshot: Snapshot, exerciseId: string): string {
  const rt = (snapshot.preferences as any)?.restTimer ?? {};
  const secs = rt[exerciseId] ?? rt[snapshot.userId] ?? 85;
  return String(secs);
}

function toKgString(weightDisplay: number, weightUnit: WeightUnit): string {
  return String(weightUnit === "KILOGRAMS" ? weightDisplay : lbToKg(weightDisplay));
}

function cell(cellType: string, value: string | null): Entity {
  return { id: newId(), cellType, value, isHidden: false } as unknown as Entity;
}

export function buildLog(
  kind: "WORKOUT" | "TEMPLATE",
  input: BuildLogInput,
  snapshot: Snapshot,
  deps: { clock: Clock; weightUnit: WeightUnit },
): Entity {
  const { clock, weightUnit } = deps;
  const ts = clock();
  const userId = snapshot.userId;
  const completed = kind === "WORKOUT";

  const cellSetGroup = input.exercises.map((ex) => {
    const def = snapshot.entities.measurement[ex.exerciseId];
    if (!def)
      throw new Error(
        `Unknown exercise id "${ex.exerciseId}" (not in snapshot; sync or create it first)`,
      );
    const configs = (Array.isArray(def.cellTypeConfigs) ? (def.cellTypeConfigs as any[]) : [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

    const cellSets: Entity[] = [];
    for (const set of ex.sets) {
      // A template set may leave values blank (Strong stores null); a logged
      // workout must say what was actually done.
      const required = (cellType: string, value: number | undefined, label: string) => {
        if (value === undefined && completed) {
          throw new Error(
            `Exercise ${ex.exerciseId} requires a ${label} value for cellType "${cellType}", but none was given.`,
          );
        }
        return value;
      };
      const cells = configs.map((cfg) => {
        if (cfg.cellType === "REPS") {
          const reps = required("REPS", set.reps, "reps");
          return cell("REPS", reps === undefined ? null : String(reps));
        }
        if (cfg.cellType === "RPE")
          return cell("RPE", set.rpe === undefined ? null : String(set.rpe));
        if (cfg.cellType === "DURATION") {
          const secs = required("DURATION", set.seconds, "seconds");
          return cell("DURATION", secs === undefined ? null : String(secs));
        }
        if (WEIGHT_CELL_TYPES.has(cfg.cellType)) {
          const weight = required(cfg.cellType, set.weight, "weight");
          return cell(cfg.cellType, weight === undefined ? null : toKgString(weight, weightUnit));
        }
        throw new Error(
          `Refusing to write unknown cell type "${cfg.cellType}" for exercise ${ex.exerciseId}`,
        );
      });
      cellSets.push({
        id: newId(),
        cellSetTag: null,
        isCompleted: completed,
        isHidden: false,
        cells,
      } as unknown as Entity);
      // trailing rest timer for this working set
      cellSets.push({
        id: newId(),
        cellSetTag: null,
        isCompleted: completed,
        isHidden: false,
        cells: [cell("REST_TIMER", restSeconds(snapshot, ex.exerciseId))],
      } as unknown as Entity);
    }

    return {
      id: newId(),
      isHidden: false,
      groupIndex: null,
      _links: { measurement: { href: `/api/users/${userId}/measurements/${ex.exerciseId}` } },
      cellSets,
    } as unknown as Entity;
  });

  const base: any = {
    id: newId(),
    logType: kind,
    name: { custom: input.name },
    isHidden: false,
    isArchived: false,
    access: "PRIVATE",
    isGlobal: false,
    created: ts,
    lastChanged: ts,
    _links: { user: { href: `/api/users/${userId}` } },
    _embedded: { cellSetGroup },
  };
  if (kind === "WORKOUT") {
    base.startDate = input.startDate ?? ts;
    base.endDate = input.endDate ?? ts;
    if (input.templateId) {
      base._links.template = { href: `/api/users/${userId}/templates/${input.templateId}` };
    }
  }
  return base as Entity;
}
