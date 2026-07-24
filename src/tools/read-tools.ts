import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ReadService } from "../services/read-service.js";

type Deps = { service: ReadService; sync: () => Promise<{ pages: number }> };

const text = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
});

export function registerReadTools(server: McpServer, deps: Deps): void {
  const { service, sync } = deps;

  server.registerTool(
    "strong_sync",
    {
      description: "Sync the local snapshot from Strong (delta if possible, else full).",
      inputSchema: {},
    },
    async () => {
      const { pages } = await sync();
      return text({ ok: true, pagesWalked: pages });
    },
  );

  server.registerTool(
    "strong_whoami",
    {
      description: "Show the current user id, unit preference, last sync time, and entity counts.",
      inputSchema: {},
    },
    async () => text(service.whoami()),
  );

  server.registerTool(
    "strong_list_workouts",
    {
      description: "List recent workouts (newest first).",
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async (args: { limit?: number }) => text(service.listWorkouts({ limit: args.limit })),
  );

  server.registerTool(
    "strong_get_workout",
    {
      description: "Get one workout in full, with sets in display units.",
      inputSchema: { id: z.string() },
    },
    async (args: { id: string }) => text(service.getWorkout(args.id)),
  );

  server.registerTool(
    "strong_list_templates",
    { description: "List saved workout templates.", inputSchema: {} },
    async () => text(service.listTemplates()),
  );

  server.registerTool(
    "strong_list_exercises",
    {
      description: "List exercise definitions; optional name search.",
      inputSchema: { search: z.string().optional() },
    },
    async (args: { search?: string }) => text(service.listExercises(args.search)),
  );

  server.registerTool(
    "strong_get_exercise_history",
    {
      description: "All logged sets for one exercise over time (by exercise id).",
      inputSchema: { exerciseId: z.string() },
    },
    async (args: { exerciseId: string }) => text(service.getExerciseHistory(args.exerciseId)),
  );

  server.registerTool(
    "strong_list_measurements",
    {
      description: "List body measurements; optional type filter (e.g. WEIGHT).",
      inputSchema: { type: z.string().optional() },
    },
    async (args: { type?: string }) => text(service.listMeasurements(args.type)),
  );
}
