# strong-mcp — Design

**Date:** 2026-07-21
**Status:** Approved (design phase)
**Author:** Justin (with Claude)

## 1. Purpose

`strong-mcp` is a personal, single-user [Model Context Protocol](https://modelcontextprotocol.io) server that exposes the [Strong](https://www.strong.app) workout app's data to an MCP client (Claude Desktop / Claude Code) for **both reading and writing**. It lets you ask Claude to analyze your training history and to log workouts, edit templates, record body measurements, and manage custom exercises — all against your real Strong account.

- **Runtime:** TypeScript, official `@modelcontextprotocol/sdk`
- **Transport:** stdio (launched by the MCP client)
- **Scope:** single user (you), local machine

## 2. Key discovery: Strong is a sync API, not a REST API

Strong has **no per-resource REST endpoints** for mutation. Instead:

- **Reads** pull the full user document via a paginated *continuation sync*.
- **Writes** are a `PUT /api/users/{userId}` of a **partial user document** whose `_embedded` collections contain **complete copies** of only the entities that changed.

This single fact drives the entire architecture: to construct any write, the server must already hold the **complete current state** of the entities it touches (every child ID and value). Therefore the server maintains a **local normalized snapshot** of the account that both reads and writes operate against.

All of the following was verified from captured Proxyman traffic (see §11):

- Auth: login, refresh, logout
- Continuation sync (delta + full), including the "caught up" signal
- Template create / update / delete
- Workout log / update / delete
- Body measurement (`measuredValue`) log / delete
- Custom exercise (`measurement`) create / edit / archive

There are **zero unproven write shapes** in the v1 scope.

## 3. Architecture

Layered, each layer independently testable:

```
MCP Tools  ──►  Domain Services  ──►  Sync Engine  ──►  HTTP Client  ──►  Strong API
(Zod schemas,   (workouts,            (snapshot,        (auth header,
 unit convert,   templates,            normalize HAL,    client headers,
 formatting)     measurements,         build PUT         retries, proxy)
                 exercises)            envelope)
       │              │                     │
       └──────────────┴────►  Snapshot Store (disk JSON)  ◄────  TokenManager
```

### 3.1 HTTP Client
The single place that talks to `back.strong.app`. Responsibilities:
- Inject `Authorization: Bearer <token>` (from TokenManager) and Strong's client headers: `X-Client-Platform: ios`, `X-Client-Version`, `X-Client-Build`, `User-Agent: Strong iOS`, `Accept: application/json`.
- Retries with backoff on 5xx / network errors.
- On `401`: trigger one token refresh + retry, then surface a clear error.
- **Success detection is by HTTP status code** — PUT responses have an empty body.
- Optional `proxyUrl` passthrough (e.g. `http://localhost:9090`) so traffic can still be watched in Proxyman during development.

### 3.2 TokenManager
Owns the token lifecycle (see §5).

### 3.3 Sync Engine
Owns the snapshot lifecycle (see §4). Full sync, delta sync, HAL normalization, and building the write envelope.

### 3.4 Snapshot Store
Disk persistence of the normalized snapshot + continuation cursor. Default `~/.strong-mcp/snapshot.json` (configurable). Also persists token state (see §5), separately.

### 3.5 Domain Services
One module per entity type: `WorkoutService`, `TemplateService`, `MeasurementService` (body values), `ExerciseService` (exercise definitions). They hold all business logic — unit conversion, entity construction, soft-delete cascades — and never touch HTTP directly.

### 3.6 MCP Tools
Thin adapters: Zod input schema → call a service method → format output. No business logic.

## 4. Data model & snapshot

### 4.1 Entity nesting

The Strong user document embeds these collections: `log`, `measurement`, `measuredValue`, `folder`, `tag`, `metric`, `widget`.

```
log (logType: TEMPLATE | WORKOUT)      ← templates AND workouts are "logs"
 └─ cellSetGroup                        ← one exercise instance
     │  _links.measurement → exercise definition ("measurement")
     └─ cellSet                         ← one set, OR a single REST_TIMER row
         └─ cell                        ← typed value {cellType, value, isHidden}
```

**Terminology gotcha:** an **exercise definition** is stored in the `measurement` collection with `measurementType: "EXERCISE"`. A **body measurement** (bodyweight, body-fat, calories) is a `measuredValue`. These are different things despite the similar names.

### 4.2 Entities

| Collection | Meaning | Shape notes |
|---|---|---|
| `log` | Templates (`logType:TEMPLATE`) and workouts (`logType:WORKOUT`) | Nested cellSetGroups. Workouts additionally have `startDate`/`endDate` and often `_links.template` back to their source. |
| `measurement` | Exercise **definition** (`measurementType:EXERCISE`) | Flat + `cellTypeConfigs`, `_links.tag[]`, `name.custom`, `instructions`, `tools[]`. |
| `measuredValue` | A logged body metric value | **Flat**, no nesting. `{measurementTypeValue, value, startDate, ...}`. |
| `folder` | Organizes templates | Ordered list of template `_links`. |
| `tag`, `metric`, `widget` | Organizational / carried through | Not deeply modeled in v1; passed through untouched. |

### 4.3 Cell types & exercise configuration

Cells are typed: seen so far `WEIGHTED_BODYWEIGHT`, `DUMBBELL_WEIGHT`, `BARBELL_WEIGHT`, `REPS`, `RPE`, `REST_TIMER`. Treated as an **open enum**: known types get special handling (unit conversion), unknown types pass through untouched. **The server never chokes on an unrecognized cell type.**

Each exercise definition carries `cellTypeConfigs`: an ordered list of `{cellType, mandatory, index, isExponent}` describing what a set for that exercise looks like. **This is authoritative** — see §6.3.

### 4.4 Set / rest-timer structure inside a log

Within a `cellSetGroup`, working sets and rest timers **alternate as separate cellSets**:
- A **working set**: `cellSet` with `cells: [<weight>, REPS, RPE, ...]`, `isCompleted: true` (for workouts).
- Followed by a **rest timer**: a separate `cellSet` whose sole cell is `{cellType: REST_TIMER, value: "<seconds>"}`.

So "3 working sets" ⇒ 3 working cellSets interleaved with (up to) 3 rest-timer cellSets. The workout/template builders must generate this alternating pattern.

### 4.5 Weights & units

- Weights are persisted as **stringified kg floats** (e.g. `"13.6077711"` = 30 lb; `kg = lb × 0.45359237`).
- The user document reports unit preferences: `preferences.weightUnit` (`POUNDS`), `distanceUnit`, `lengthUnit`.
- **The server reads these preferences** and converts at the service boundary rather than hardcoding lbs. Tools accept/emit values in the user's display unit (lbs for this account) and echo both units where useful.
- `measuredValue.value` semantics are **type-dependent**:
  - `WEIGHT`: kg float (`90.718474` = 200 lb) — uses weight conversion.
  - `BODY_FAT_PERCENTAGE`: a **fraction** (`0.05` = 5%).
  - `CALORIC_INTAKE`: raw number (`2200`).
  - Treated as an open enum: known types converted, unknown types passed through raw with a warning.
- **Passthrough integrity:** raw values on entities we are only re-sending (not changing) are preserved byte-for-byte — we never re-round a value we didn't intend to edit.

### 4.6 Snapshot on disk

```jsonc
{
  "userId": "…",
  "continuation": "…",      // delta cursor: token from the last empty sync page
  "syncedAt": "ISO-8601",
  "preferences": { "weightUnit": "POUNDS", … },
  "entities": {
    "log": { "<id>": { … } },
    "measurement": { "<id>": { … } },
    "measuredValue": { "<id>": { … } },
    "folder": { "<id>": { … } },
    "tag": { … }, "metric": { … }, "widget": { … }
  }
}
```

## 5. Authentication

Endpoints (all `back.strong.app`):
- `POST /auth/login` — `{usernameOrEmail, password, deviceId}` → `{accessToken, refreshToken, expiresIn, userId}`.
- `POST /auth/login/refresh` — `{deviceId, accessToken, refreshToken}` → `{accessToken, refreshToken, expiresIn, userId}`.
- `POST /auth/logout` — `{accessToken, refreshToken}`.

Facts:
- Access token TTL is `expiresIn: 1200` (20 min); it's a JWT (`exp` claim also available).
- **The refresh token rotates**: each refresh returns a *new* refreshToken. The old one is spent.

### TokenManager behavior
- **State persisted to disk** (e.g. `~/.strong-mcp/token.json`, `chmod 600`): `{accessToken, refreshToken, expiresAt, deviceId, userId}`.
- **Primary renewal path: refresh.** Before a request, if within ~60s of `expiresAt`, call `/auth/login/refresh`, then **persist the newly rotated refreshToken** (critical — failing to persist breaks the next refresh).
- **Initial credential (v1): token seeding only.** A captured `{accessToken, refreshToken}` pair is seeded into config; **the password is never stored on disk.** From there, refresh keeps the session alive indefinitely as long as the server refreshes before the refresh token itself goes stale.
- **Fallback:** if refresh fails, surface a clear "re-auth required — re-seed tokens" error. (Password-based auto re-login is intentionally deferred; see §12. Revisit only if re-seeding becomes painful.)
- **Never log** tokens or credentials.
- `deviceId` is a stable configured UUID (must match the one used when the seeded tokens were minted).

## 6. Sync engine

### 6.1 One loop, two entry points
- `fullSync()` — start from no cursor; follow the `_links.next` href (carries the next `continuation` token) until a page returns **all `_embedded` collections empty** (the "caught up" signal). Normalize every entity into the snapshot; persist the final token.
- `deltaSync()` — same loop starting from the persisted cursor; apply only changed entities (including `isHidden` soft-deletes) onto the existing snapshot.

Full and delta sync are the **same algorithm** with a different starting cursor. If the stored cursor is rejected, fall back to `fullSync()`.

### 6.2 Write flow (all mutations)
1. `deltaSync()` first (usually one cheap empty page) so cross-links aren't stale.
2. Mutate the target entity in a working copy: client-generated UUIDs for new entities, bumped `lastChanged`, ISO timestamps.
3. Build the envelope: `{ id: userId, strongAnalytics: false, _embedded: { …only changed collections populated, rest as [] } }`.
4. `PUT /api/users/{userId}`.
5. On 2xx: apply the same mutation to the local snapshot and persist. On failure: surface error, snapshot unchanged.

### 6.3 Workout building uses `cellTypeConfigs`
When logging/editing a workout, for each exercise the builder **looks up that exercise definition's `cellTypeConfigs`** to decide which cell types a set emits (e.g. `BARBELL_WEIGHT` vs `DUMBBELL_WEIGHT` vs `WEIGHTED_BODYWEIGHT`) and in what order. It does **not** hardcode a weight cell type.

### 6.4 Soft-delete is generic
"Delete" is never a hard delete. It's a `PUT` flipping `isHidden: true`:
- **Logs (templates & workouts):** cascade `isHidden: true` to the log **and every** cellSetGroup / cellSet / cell.
- **Exercises & measuredValues (flat):** flip `isHidden: true` on the single entity.

One `softDelete(entity)` routine handles all types (with/without cascade).

## 7. MCP tool surface

### System / sync
- `strong_sync` — force delta/full sync; return counts. (Most tools auto-sync; this is manual control.)
- `strong_whoami` — profile + unit preferences.

### Reads
- `strong_list_workouts` — recent workouts (date range / limit), summarized.
- `strong_get_workout` — one workout in full (sets, weights in display units).
- `strong_list_templates` / `strong_get_template`
- `strong_list_exercises` — exercise definitions, searchable by name; shows `cellTypeConfigs`.
- `strong_get_exercise_history` — all sets logged for a given exercise over time ("how's my bench trending").
- `strong_list_measurements` — body metrics (bodyweight, body-fat, calories, …).

### Writes
- `strong_log_workout` — create a completed workout: name, optional source template, exercises → sets `{reps, weight, rpe?}`. Builder emits cellSetGroups + alternating rest-timer cellSets using each exercise's `cellTypeConfigs`; converts display units → kg.
- `strong_update_workout` / `strong_delete_workout` — full-entity replace / cascading soft-delete.
- `strong_create_template` / `strong_update_template` / `strong_delete_template`
- `strong_log_measurement` — body metric entry; type-aware value conversion.
- `strong_delete_measurement`
- `strong_create_exercise` — custom exercise: name, `cellTypeConfigs`, tags, notes/instructions.
- `strong_update_exercise` / `strong_archive_exercise` (soft-delete; no hard delete exists).

### Tool conventions
- Every write requires an explicit target and returns a summary of what changed — no silent guessing about which entity to mutate.
- Weight inputs/outputs are in the account's display unit; responses echo kg where helpful.

## 8. Error handling

- **Auth:** refresh → re-login fallback → clear "re-auth required" error. 401 mid-request triggers one refresh+retry.
- **Sync drift:** rejected cursor ⇒ automatic full re-sync. If you also edited in the app, the pre-write `deltaSync` pulls those changes first.
- **Writes:** status-code based; on non-2xx, snapshot is left unchanged and the error is surfaced with context.
- **Unknown enums** (cell types, measurement types): passed through untouched, never fatal.
- **Never** log tokens, passwords, or the full bearer.

## 9. Testing strategy

- **Unit:** HAL normalization (firehose → snapshot), envelope builder (snapshot entity → PUT body), unit conversion (lb↔kg, body-fat fraction, per-type measuredValue), soft-delete cascade, workout builder w/ `cellTypeConfigs`. Driven by the captured fixtures in §11.
- **Golden fixtures:** each captured curl becomes a fixture; builders must reproduce the observed PUT body (modulo generated UUIDs/timestamps) from equivalent inputs.
- **TokenManager:** refresh rotation persistence, expiry threshold, fallback ordering (with a fake clock).
- **Integration (optional, gated behind an env flag):** live against the real account through the Proxyman proxy, exercising create→read→delete round-trips on throwaway entities.

## 10. Configuration

Env / config file:
- `STRONG_ACCESS_TOKEN`, `STRONG_REFRESH_TOKEN` — seeded token pair (required for v1)
- `STRONG_DEVICE_ID` — must match the device the seeded tokens were minted with
- `STRONG_DATA_DIR` (default `~/.strong-mcp`)
- `STRONG_PROXY_URL` (optional, dev)
- Unit override (optional; default = account preference)

Seeded tokens are read on first run and thereafter the persisted `token.json` is the source of truth (it holds the rotated refresh token). Password-based config (`STRONG_USERNAME`/`STRONG_PASSWORD`) is intentionally **not** part of v1.

## 11. Verified endpoint reference (captured)

All captured via Proxyman against the real account. Base: `https://back.strong.app`.

| # | Action | Method / Path | Notes |
|---|---|---|---|
| 1 | Login | `POST /auth/login` | `{usernameOrEmail, password, deviceId}` → tokens |
| 2 | Refresh | `POST /auth/login/refresh` | `{deviceId, accessToken, refreshToken}` → rotated tokens |
| 3 | Logout | `POST /auth/logout` | `{accessToken, refreshToken}` |
| 4 | Sync page | `GET /api/users/{id}/?continuation=…&limit=300&include=…` | `_links.next` carries next token; all-empty page = caught up |
| 5 | Template create | `PUT /api/users/{id}` | `_embedded.template[]` + updated `folder` |
| 6 | Template update | `PUT /api/users/{id}` | full-entity replace |
| 7 | Template delete | `PUT /api/users/{id}` | cascading `isHidden:true` |
| 8 | Workout log | `PUT /api/users/{id}` | `log logType:WORKOUT`, `startDate`/`endDate`, `_links.template`; alternating rest-timer cellSets |
| 9 | Workout delete | `PUT /api/users/{id}` | cascading `isHidden:true` |
| 10 | Body measurement log | `PUT /api/users/{id}` | flat `measuredValue[]`; per-type value semantics |
| 11 | Exercise create | `PUT /api/users/{id}` | `measurement measurementType:EXERCISE`, `cellTypeConfigs`, `_links.tag[]` |
| 12 | Exercise edit | `PUT /api/users/{id}` | full-entity replace |
| 13 | Exercise archive | `PUT /api/users/{id}` | `isHidden:true` (flat) |

**Write envelope (all writes):**
```jsonc
PUT /api/users/{userId}
{
  "id": "{userId}",
  "strongAnalytics": false,
  "_embedded": {
    "template": [], "log": [], "measurement": [], "measuredValue": [],
    "folder": [], "tag": [], "metric": [], "widget": []
    // only changed collections populated
  }
}
```

## 12. Out of scope (v1)

- Multi-user / hosted deployment (single local user only).
- **Password-based auth / auto re-login.** v1 seeds a token pair and relies on refresh; if refresh ever fails you re-seed. Storing the password for unattended re-login is deferred and revisited only if re-seeding becomes painful.
- Deep modeling of `metric`, `widget`, `folder` reordering beyond what template CRUD needs.
- Per-collection read endpoints (`/api/logs/{userId}`, etc.) — continuation sync is the backbone; these are a possible later optimization.
- Distance/time/cardio-specific cell handling beyond generic passthrough (revisit when such data appears).
