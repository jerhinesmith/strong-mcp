import type { Entity, Snapshot } from "../types.js";
import { formatKg, formatLb, toDisplayMeasuredValue, type WeightUnit } from "../units.js";

interface Options {
  getSnapshot: () => Snapshot;
  getWeightUnit: () => WeightUnit;
  userId: string;
}

const WEIGHT_CELL_TYPES = new Set([
  "DUMBBELL_WEIGHT",
  "BARBELL_WEIGHT",
  "WEIGHTED_BODYWEIGHT",
  "WEIGHT",
]);

function customName(e: Entity): string {
  const n = e.name as { custom?: string; en?: string } | undefined;
  return n?.custom ?? n?.en ?? "";
}

function measurementIdOf(group: any): string | null {
  const href = group?._links?.measurement?.href;
  if (typeof href !== "string") return null;
  return href.split("/").pop() ?? null;
}

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? null : n;
}

export class ReadService {
  constructor(private readonly opts: Options) {}
  private get snap() {
    return this.opts.getSnapshot();
  }

  private displayWeightKg(kg: number): number {
    return this.opts.getWeightUnit() === "KILOGRAMS" ? formatKg(kg) : formatLb(kg);
  }
  private get weightUnitLabel(): string {
    return this.opts.getWeightUnit() === "KILOGRAMS" ? "kg" : "lb";
  }

  private visible(map: Record<string, Entity>): Entity[] {
    return Object.values(map).filter((e) => e.isHidden !== true);
  }

  whoami() {
    const s = this.snap;
    const counts: Record<string, number> = {};
    for (const [name, map] of Object.entries(s.entities)) {
      counts[name] = this.visible(map as Record<string, Entity>).length;
    }
    return {
      userId: this.opts.userId,
      weightUnit: this.opts.getWeightUnit(),
      syncedAt: s.syncedAt,
      counts,
    };
  }

  private groups(log: Entity): any[] {
    const g = (log._embedded as any)?.cellSetGroup;
    return Array.isArray(g) ? g : [];
  }

  /** Extracts working sets (weight/reps/rpe) for one exercise group, skipping REST_TIMER-only cellSets. */
  private setsOf(
    group: any,
  ): { reps: number | null; weight: number | null; unit: string; rpe: number | null }[] {
    const cellSets = Array.isArray(group?.cellSets) ? group.cellSets : [];
    const out: any[] = [];
    for (const cs of cellSets) {
      if (cs?.isHidden === true) continue;
      const cells = Array.isArray(cs?.cells) ? cs.cells : [];
      const isRestOnly = cells.length > 0 && cells.every((c: any) => c.cellType === "REST_TIMER");
      if (isRestOnly) continue;
      let reps: number | null = null;
      let weight: number | null = null;
      let rpe: number | null = null;
      for (const c of cells) {
        if (c.cellType === "REPS") reps = num(c.value);
        else if (c.cellType === "RPE") rpe = num(c.value);
        else if (WEIGHT_CELL_TYPES.has(c.cellType)) {
          const kg = num(c.value);
          weight = kg === null ? null : this.displayWeightKg(kg);
        }
      }
      out.push({ reps, weight, unit: this.weightUnitLabel, rpe });
    }
    return out;
  }

  private exerciseName(measurementId: string | null): string {
    if (!measurementId) return "Unknown";
    const m = this.snap.entities.measurement[measurementId];
    return m ? customName(m) : "Unknown";
  }

  listWorkouts(opts?: { limit?: number }) {
    const rows = this.visible(this.snap.entities.log)
      .map((w) => ({
        id: w.id,
        name: customName(w),
        startDate: w.startDate as string | undefined,
        exerciseCount: this.groups(w).length,
      }))
      .sort((a, b) => (b.startDate ?? "").localeCompare(a.startDate ?? ""));
    return opts?.limit ? rows.slice(0, opts.limit) : rows;
  }

  getWorkout(id: string) {
    const w = this.snap.entities.log[id];
    if (!w || w.isHidden === true) return null;
    return {
      id: w.id,
      name: customName(w),
      exercises: this.groups(w).map((g) => ({
        name: this.exerciseName(measurementIdOf(g)),
        sets: this.setsOf(g),
      })),
    };
  }

  listTemplates() {
    return this.visible(this.snap.entities.template).map((t) => ({
      id: t.id,
      name: customName(t),
    }));
  }

  listExercises(search?: string) {
    const q = search?.toLowerCase();
    return this.visible(this.snap.entities.measurement)
      .filter((m) => m.measurementType === "EXERCISE")
      .map((m) => ({
        id: m.id,
        name: customName(m),
        cellTypes: (Array.isArray(m.cellTypeConfigs) ? (m.cellTypeConfigs as any[]) : []).map(
          (c) => c.cellType,
        ),
      }))
      .filter((m) => !q || m.name.toLowerCase().includes(q));
  }

  getExerciseHistory(exerciseId: string) {
    const out: {
      workoutId: string;
      date?: string;
      sets: { reps: number | null; weight: number | null; unit: string }[];
    }[] = [];
    for (const w of this.visible(this.snap.entities.log)) {
      for (const g of this.groups(w)) {
        if (measurementIdOf(g) !== exerciseId) continue;
        out.push({
          workoutId: w.id,
          date: w.startDate as string | undefined,
          sets: this.setsOf(g).map(({ reps, weight, unit }) => ({ reps, weight, unit })),
        });
      }
    }
    return out.sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));
  }

  listMeasurements(type?: string) {
    return this.visible(this.snap.entities.measuredValue)
      .filter((v) => !type || v.measurementTypeValue === type)
      .map((v) => {
        const t = String(v.measurementTypeValue);
        const { value, unit } = toDisplayMeasuredValue(
          t,
          Number(v.value),
          this.opts.getWeightUnit(),
        );
        return { id: v.id, type: t, value, unit, date: v.startDate as string | undefined };
      });
  }
}
