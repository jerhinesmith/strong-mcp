import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { fetch } from "undici";
import { makeTtyPrompts, runLogin } from "./auth/login-command.js";
import type { FetchLikeWithHeaders } from "./auth/mfa.js";
import { TokenStore } from "./auth/token-store.js";
import { loadConfig } from "./config.js";
import type { FetchLike } from "./http/client.js";
import { buildServer } from "./server.js";

async function runLoginCommand() {
  const config = loadConfig(process.env);
  // Reuse a prior deviceId if token.json is readable. A corrupt token.json must
  // NOT brick the command meant to repair it — fall back to minting a fresh id.
  let existingDeviceId: string | undefined;
  try {
    existingDeviceId = (await new TokenStore(config.dataDir).read())?.deviceId;
  } catch {
    existingDeviceId = undefined;
  }
  await runLogin({
    fetchImpl: fetch as unknown as FetchLikeWithHeaders,
    dataDir: config.dataDir,
    prompts: makeTtyPrompts(),
    existingDeviceId,
    // Deliberately NOT routed through STRONG_PROXY_URL: that is a TLS-terminating
    // debug proxy (Proxyman) and would expose the plaintext password. Login always
    // goes straight to Strong.
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
    process.exit(0); // the TTY readline keeps stdin ref'd; exit explicitly
  }
  await runServer();
}

main().catch((err) => {
  process.stderr.write(`strong-mcp fatal: ${(err as Error).message}\n`);
  process.exit(1);
});
