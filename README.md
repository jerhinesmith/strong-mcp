# strong-mcp

An [MCP](https://modelcontextprotocol.io) server for the [Strong](https://www.strong.app) workout app. It gives an MCP client (Claude, etc.) read **and** write access to your Strong data — workouts, templates, exercises, and body measurements — over stdio.

> **Unofficial.** This project is not affiliated with or endorsed by Strong. It talks to Strong's private sync API, reverse-engineered from captured traffic. The two edit/delete shapes marked _inferred_ below were never observed directly and verify themselves against the server after each write. Use at your own risk against your own account.

## How it works

Strong is a **sync-document API**, not a REST API: the client GETs a paginated snapshot of the user document and every write is a `PUT /api/users/{id}` carrying a partial document. strong-mcp mirrors that model:

- **Sync** — pulls the snapshot (delta when possible, full otherwise) and caches it locally as `snapshot.json`.
- **Reads** — served entirely from the local snapshot, so they're instant and offline-friendly.
- **Writes** — serialized one at a time: re-sync → build the minimal change → `PUT` → apply optimistically → persist. A write is only considered landed on an HTTP 2xx; on any error the local snapshot is left untouched.
- **Units** — you speak your account's display unit (pounds by default). Weights are converted to kilograms at the API boundary, since Strong stores everything in kg.

## Requirements

- Node.js ≥ 20
- A seeded Strong token pair (see below). **No password is stored** — the server authenticates only with the tokens you provide and refreshes them itself.

## Install

```bash
npm install
npm run build
```

## Configuration

Configured entirely through environment variables (an [`.env.example`](.env.example) is provided). The token pair is seeded once; the server rotates and persists refreshed tokens to `token.json` in its data directory.

| Variable | Required | Description |
| --- | --- | --- |
| `STRONG_ACCESS_TOKEN` | yes | Access token captured from an `/auth/login` or `/auth/login/refresh` response. |
| `STRONG_REFRESH_TOKEN` | yes | Matching refresh token. |
| `STRONG_DEVICE_ID` | yes | The `deviceId` those tokens were minted with (from the captured request body). |
| `STRONG_DATA_DIR` | no | Where `token.json` + `snapshot.json` live. Default: `~/.strong-mcp`. |
| `STRONG_WEIGHT_UNIT` | no | Force display unit `POUNDS` or `KILOGRAMS`. Default: your account preference. |
| `STRONG_PROXY_URL` | no | HTTP proxy (e.g. Proxyman at `http://localhost:9090`) for debugging. |

### Seeding tokens

The tokens are read from a request/response you capture with an HTTPS proxy such as [Proxyman](https://proxyman.io):

1. Proxy the Strong app and trigger a login (or let it refresh).
2. From the `/auth/login` (or `/auth/login/refresh`) exchange, copy `accessToken`, `refreshToken`, and the request's `deviceId`.
3. Put them in your environment / MCP client config.

## Usage

Run over stdio from an MCP client. Example Claude Desktop / Claude Code config:

```json
{
  "mcpServers": {
    "strong": {
      "command": "node",
      "args": ["/absolute/path/to/strong-mcp/dist/index.js"],
      "env": {
        "STRONG_ACCESS_TOKEN": "…",
        "STRONG_REFRESH_TOKEN": "…",
        "STRONG_DEVICE_ID": "…"
      }
    }
  }
}
```

On startup the server does an initial sync (reported on stderr) and then serves the tools below.

## Tools

### Read

| Tool | Description |
| --- | --- |
| `strong_sync` | Sync the local snapshot from Strong (delta if possible, else full). |
| `strong_whoami` | Current user id, unit preference, last sync time, and entity counts. |
| `strong_list_workouts` | List recent workouts (newest first); optional `limit`. |
| `strong_get_workout` | One workout in full, with sets in display units. |
| `strong_list_templates` | List saved workout templates. |
| `strong_list_exercises` | List exercise definitions; optional name `search`. |
| `strong_get_exercise_history` | All logged sets for one exercise over time. |
| `strong_list_measurements` | List body measurements; optional `type` filter (e.g. `WEIGHT`). |

### Write

| Tool | Description |
| --- | --- |
| `strong_log_workout` | Log a completed workout (exercises by definition id; weights in display unit). |
| `strong_delete_workout` | Soft-delete a logged workout by id. |
| `strong_create_template` | Create a workout template (optional `folderId`, defaults to My Templates). |
| `strong_update_template` | Rename a template by id. |
| `strong_delete_template` | Soft-delete a template by id (also unlinks it from its folder). |
| `strong_log_measurement` | Log a body measurement (`WEIGHT`, `BODY_FAT_PERCENTAGE`, `CALORIC_INTAKE`, …). |
| `strong_create_exercise` | Create a custom exercise definition. |
| `strong_update_exercise` | Rename a custom exercise by id. |
| `strong_archive_exercise` | Archive (soft-delete) a custom exercise by id. |
| `strong_update_workout` | _Inferred._ Edit sets in a logged workout; verifies the edit against the server (`serverConfirmed`). |
| `strong_delete_measurement` | _Inferred._ Soft-delete a body measurement; verifies against the server (`serverConfirmed`). |

Deletes are **soft** (Strong has no hard delete): the entity is flagged `isHidden` rather than removed.

The two _inferred_ tools re-sync server truth after the write and report `serverConfirmed`: `true` (Strong accepted it), `false` (local view is optimistic and unverified — run `strong_sync` to reconcile), or `undefined` (the confirmation re-sync failed; the write itself still succeeded).

## Development

```bash
npm run dev        # run from source via tsx
npm test           # run the vitest suite
npm run typecheck  # tsc --noEmit
npm run lint       # biome check
npm run lint:fix   # biome check --write
npm run build      # compile to dist/
```

CI (GitHub Actions) runs lint → typecheck → test → build on every push and PR to `main`.

Design and implementation notes live under [`docs/`](docs/).

## License

[MIT](LICENSE) © 2026 Justin Rhinesmith
