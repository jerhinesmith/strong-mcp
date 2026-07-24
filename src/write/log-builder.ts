import type { Entity, Snapshot } from "../types.js";
import { lbToKg, type WeightUnit } from "../units.js";
import { type Clock, newId } from "./ids.js";

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT",
  "BARBELL_WEIGHT",
  "WEIGHTED_BODYWEIGHT",
  "WEIGHT",
]);

export interface SetInput {
  reps: number;
  weight: number;
  rpe?: number;
}
export interface ExerciseInput {
  exerciseId: string;
  sets: SetInput[];
}
export interface BuildLogInput {
  name: string;
  templateId?: string;
  exercises: ExerciseInput[];
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
      const cells = configs.map((cfg) => {
        if (cfg.cellType === "REPS") return cell("REPS", String(set.reps));
        if (cfg.cellType === "RPE")
          return cell("RPE", set.rpe === undefined ? null : String(set.rpe));
        if (WEIGHT_CELL_TYPES.has(cfg.cellType))
          return cell(cfg.cellType, toKgString(set.weight, weightUnit));
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
    base.startDate = ts;
    base.endDate = ts;
    if (input.templateId) {
      base._links.template = { href: `/api/users/${userId}/templates/${input.templateId}` };
    }
  }
  return base as Entity;
}
