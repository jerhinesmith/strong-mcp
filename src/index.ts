import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch } from "undici";
import { runLogin, ttyPrompts } from "./auth/login-command.js";
import { TokenStore } from "./auth/token-store.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./http/client.js";
import { buildServer } from "./server.js";

async function runLoginCommand() {
  const config = loadConfig(process.env);
  const existing = await new TokenStore(config.dataDir).read();
  await runLogin({
    fetchImpl: fetch as unknown as FetchLike,
    dataDir: config.dataDir,
    prompts: ttyPrompts,
    existingDeviceId: existing?.deviceId,
    proxyUrl: config.proxyUrl,
  });
}

async function runServer() {
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

async function main() {
  if (process.argv[2] === "login") {
    await runLoginCommand();
    return;
  }
  await runServer();
}

main().catch((err) => {
  process.stderr.write(`strong-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
