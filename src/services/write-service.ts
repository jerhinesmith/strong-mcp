import type { Entity, Snapshot } from "../types.js";
import type { WeightUnit } from "../units.js";
import { editEntityName } from "../write/edit.js";
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
}

export interface CreateExerciseInput {
  name: string;
  cellTypeConfigs: { cellType: string; mandatory?: boolean; isExponent?: boolean }[];
  notes?: string;
  tagIds?: string[];
}

function requireVisible(
  snapshot: Snapshot,
  collection: "log" | "template" | "measurement",
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
}
