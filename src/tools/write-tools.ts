import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WriteService } from "../services/write-service.js";

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

const setSchema = {
  reps: z.number().int().positive(),
  weight: z.number().nonnegative(),
  rpe: z.number().optional(),
};
const exerciseSchema = { exerciseId: z.string(), sets: z.array(z.object(setSchema)).min(1) };
const cellConfigSchema = {
  cellType: z.string(),
  mandatory: z.boolean().optional(),
  isExponent: z.boolean().optional(),
};

export function registerWriteTools(server: McpServer, service: WriteService): void {
  server.registerTool(
    "strong_log_workout",
    {
      description:
        "Log a completed workout. Exercises referenced by definition id (use strong_list_exercises). Weights in your display unit.",
      inputSchema: {
        name: z.string(),
        templateId: z.string().optional(),
        exercises: z.array(z.object(exerciseSchema)).min(1),
      },
    },
    async (a: any) => text(await service.logWorkout(a)),
  );

  server.registerTool(
    "strong_delete_workout",
    { description: "Soft-delete a logged workout by id.", inputSchema: { id: z.string() } },
    async (a: any) => text(await service.deleteWorkout(a.id)),
  );

  server.registerTool(
    "strong_create_template",
    {
      description: "Create a workout template. Optional folderId (defaults to My Templates).",
      inputSchema: {
        name: z.string(),
        folderId: z.string().optional(),
        exercises: z.array(z.object(exerciseSchema)).min(1),
      },
    },
    async (a: any) => text(await service.createTemplate(a)),
  );

  server.registerTool(
    "strong_update_template",
    { description: "Rename a template by id.", inputSchema: { id: z.string(), name: z.string() } },
    async (a: any) => text(await service.updateTemplateName(a.id, a.name)),
  );

  server.registerTool(
    "strong_delete_template",
    {
      description: "Soft-delete a template by id (also unlinks it from its folder).",
      inputSchema: { id: z.string() },
    },
    async (a: any) => text(await service.deleteTemplate(a.id)),
  );

  server.registerTool(
    "strong_log_measurement",
    {
      description:
        "Log a body measurement. type e.g. WEIGHT (display unit), BODY_FAT_PERCENTAGE (whole %), CALORIC_INTAKE (kcal).",
      inputSchema: { type: z.string(), value: z.number() },
    },
    async (a: any) => text(await service.logMeasurement(a)),
  );

  server.registerTool(
    "strong_create_exercise",
    {
      description: "Create a custom exercise definition.",
      inputSchema: {
        name: z.string(),
        cellTypeConfigs: z.array(z.object(cellConfigSchema)).min(1),
        notes: z.string().optional(),
        tagIds: z.array(z.string()).optional(),
      },
    },
    async (a: any) => text(await service.createExercise(a)),
  );

  server.registerTool(
    "strong_update_exercise",
    {
      description: "Rename a custom exercise by id.",
      inputSchema: { id: z.string(), name: z.string() },
    },
    async (a: any) => text(await service.updateExerciseName(a.id, a.name)),
  );

  server.registerTool(
    "strong_archive_exercise",
    {
      description: "Archive (soft-delete) a custom exercise by id.",
      inputSchema: { id: z.string() },
    },
    async (a: any) => text(await service.archiveExercise(a.id)),
  );
}
