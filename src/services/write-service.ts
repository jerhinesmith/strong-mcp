import type { Entity, Snapshot } from "../types.js";
import type { WeightUnit } from "../units.js";
import { editEntityName, editSetCells, verifySetCells } from "../write/edit.js";
import { buildExerciseDefinition, buildMeasuredValue } from "../write/entity-builders.js";
import type { Change } from "../write/envelope.js";
import {
  addTemplateToFolder,
  defaultFolder,
  findFolderContaining,
  removeTemplateFromFolder,
} from "../write/folders.js";
import type { Clock } from "../write/ids.js";
import { type BuildLogInput, buildLog } from "../write/log-builder.js";
import { softDelete } from "../write/soft-delete.js";
import type { WriteEngine } from "../write/write-engine.js";

interface Options {
  engine: WriteEngine;
  getWeightUnit: () => WeightUnit;
  clock: Clock;
  userId: string;
  /**
   * Full re-sync returning pristine server truth. Used only to verify the two
   * inferred write shapes (updateWorkoutSets / deleteMeasurement) after a 2xx —
   * the engine's optimistic local snapshot cannot confirm the server accepted
   * the edit. Never throws the write; a failed re-sync just leaves
   * serverConfirmed undefined.
   */
  resync: () => Promise<Snapshot>;
}

export interface CreateExerciseInput {
  name: string;
  cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[];
  notes?: string;
  tagIds?: string[];
}

function requireVisible(
  snapshot: Snapshot,
  collection: "log" | "template" | "measurement" | "measuredValue",
  id: string,
): Entity {
  const e = snapshot.entities[collection][id];
  if (!e || e.isHidden === true)
    throw new Error(`No ${collection} with id "${id}" in the current snapshot`);
  return e;
}

export class WriteService {
  constructor(private readonly opts: Options) {}
  private get deps() {
    return { clock: this.opts.clock, weightUnit: this.opts.getWeightUnit() };
  }

  logWorkout(input: BuildLogInput) {
    return this.opts.engine.write((snapshot) => {
      const log = buildLog("WORKOUT", input, snapshot, this.deps);
      return {
        changes: [{ collection: "log", entity: log }],
        summary: { id: log.id, name: input.name, exercises: input.exercises.length },
      };
    });
  }

  deleteWorkout(id: string) {
    return this.opts.engine.write((snapshot) => {
      const log = requireVisible(snapshot, "log", id);
      return {
        changes: [{ collection: "log", entity: softDelete(log, this.opts.clock) }],
        summary: { id, deleted: true as const },
      };
    });
  }

  createTemplate(input: BuildLogInput & { folderId?: string }) {
    return this.opts.engine.write((snapshot) => {
      const template = buildLog("TEMPLATE", input, snapshot, this.deps);
      const changes: Change[] = [{ collection: "template", entity: template }];
      let folder: Entity | undefined;
      if (input.folderId) {
        folder = snapshot.entities.folder[input.folderId];
        if (!folder || folder.isHidden === true) {
          throw new Error(`No folder with id "${input.folderId}" in the current snapshot`);
        }
      } else {
        folder = defaultFolder(snapshot);
      }
      if (folder)
        changes.push({
          collection: "folder",
          entity: addTemplateToFolder(folder, this.opts.userId, template.id, this.opts.clock),
        });
      return { changes, summary: { id: template.id, name: input.name } };
    });
  }

  updateTemplateName(id: string, name: string) {
    return this.opts.engine.write((snapshot) => {
      const t = requireVisible(snapshot, "template", id);
      return {
        changes: [{ collection: "template", entity: editEntityName(t, name, this.opts.clock) }],
        summary: { id },
      };
    });
  }

  deleteTemplate(id: string) {
    return this.opts.engine.write((snapshot) => {
      const t = requireVisible(snapshot, "template", id);
      const changes: Change[] = [
        { collection: "template", entity: softDelete(t, this.opts.clock) },
      ];
      const folder = findFolderContaining(snapshot, this.opts.userId, id);
      if (folder)
        changes.push({
          collection: "folder",
          entity: removeTemplateFromFolder(folder, this.opts.userId, id, this.opts.clock),
        });
      return { changes, summary: { id, deleted: true as const } };
    });
  }

  logMeasurement(input: { type: string; value: number }) {
    return this.opts.engine.write(() => {
      const v = buildMeasuredValue(input, this.deps); // throws on unknown type
      return {
        changes: [{ collection: "measuredValue", entity: v }],
        summary: { id: v.id, type: input.type },
      };
    });
  }

  createExercise(input: CreateExerciseInput) {
    return this.opts.engine.write(() => {
      const m = buildExerciseDefinition(input, this.opts.userId, { clock: this.opts.clock });
      return {
        changes: [{ collection: "measurement", entity: m }],
        summary: { id: m.id, name: input.name },
      };
    });
  }

  updateExerciseName(id: string, name: string) {
    return this.opts.engine.write((snapshot) => {
      const m = requireVisible(snapshot, "measurement", id);
      return {
        changes: [{ collection: "measurement", entity: editEntityName(m, name, this.opts.clock) }],
        summary: { id },
      };
    });
  }

  archiveExercise(id: string) {
    return this.opts.engine.write((snapshot) => {
      const m = requireVisible(snapshot, "measurement", id);
      return {
        changes: [{ collection: "measurement", entity: softDelete(m, this.opts.clock) }],
        summary: { id, archived: true as const },
      };
    });
  }

  /**
   * Full re-sync for post-write verification. Never throws: if the re-sync
   * itself fails, the write already succeeded (2xx), so we return null and
   * report serverConfirmed as undefined rather than surfacing a false error.
   */
  private async safeResync(): Promise<Snapshot | null> {
    try {
      return await this.opts.resync();
    } catch {
      return null;
    }
  }

  /**
   * INFERRED write shape (§2): the workout-edit PUT was never captured. We
   * re-send the log document with only the targeted cells rewritten
   * (byte-for-byte preservation, §6.5) and then re-sync to confirm the server
   * accepted the edit. serverConfirmed distinguishes "landed and verified"
   * from "PUT returned 2xx but server truth doesn't reflect it yet".
   */
  async updateWorkoutSets(
    id: string,
    edits: { groupIndex: number; setIndex: number; reps?: number; weight?: number; rpe?: number }[],
  ): Promise<{ id: string; serverConfirmed?: boolean }> {
    // Resolve the unit ONCE so the edit we write and the verification we run
    // agree even if the preference changed during the mid-write refresh.
    const weightUnit = this.opts.getWeightUnit();
    const deps = { clock: this.opts.clock, weightUnit };
    let sent: Entity | undefined; // the document we PUT — baseline for structural verify
    const summary = await this.opts.engine.write((snapshot) => {
      const log = requireVisible(snapshot, "log", id);
      sent = editSetCells(log, edits, deps); // throws on unmatched field / bad index
      return { changes: [{ collection: "log", entity: sent }], summary: { id } };
    });
    const fresh = await this.safeResync();
    const serverConfirmed = fresh
      ? verifySetCells(sent, fresh.entities.log[id], edits, { weightUnit })
      : undefined;
    return { ...summary, serverConfirmed };
  }

  /**
   * INFERRED write shape (§2): the measurement-delete PUT was never captured.
   * We apply the same flat soft-delete (isHidden:true) used for other deletes
   * and re-sync to confirm the entity is gone or hidden in server truth.
   */
  async deleteMeasurement(
    id: string,
  ): Promise<{ id: string; deleted: true; serverConfirmed?: boolean }> {
    const summary = await this.opts.engine.write((snapshot) => {
      const v = requireVisible(snapshot, "measuredValue", id);
      return {
        changes: [{ collection: "measuredValue", entity: softDelete(v, this.opts.clock) }],
        summary: { id, deleted: true as const },
      };
    });
    const fresh = await this.safeResync();
    const after = fresh?.entities.measuredValue[id];
    const serverConfirmed = fresh ? after === undefined || after.isHidden === true : undefined;
    return { ...summary, serverConfirmed };
  }
}
