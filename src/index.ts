import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch } from "undici";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./http/client.js";
import { buildServer } from "./server.js";

async function main() {
  const config = loadConfig(process.env);
  const { server, sync } = await buildServer(config, fetch as unknown as FetchLike);
  try {
    const { pages } = await sync();
    process.stderr.write(`strong-mcp: initial sync walked ${pages} page(s)\n`);
  } catch (err) {
    process.stderr.write(`strong-mcp: initial sync failed: ${(err as Error).message}\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`strong-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
