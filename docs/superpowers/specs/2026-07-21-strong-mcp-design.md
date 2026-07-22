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

The following was **verified** from captured Proxyman traffic (see §11):

- Auth: login, refresh, logout
- Continuation sync, including the "caught up" signal
- Template create / update / delete
- Workout **log** and **delete**
- Body measurement (`measuredValue`) **log**
- Custom exercise (`measurement`) create / edit / archive

Two v1 write shapes are **inferred, not captured** — safe inferences from the general write model, but flagged as risk and to be verified before/while building:

- **Workout update** — inferred to be full-entity replace, identical mechanics to template update (§11, row 6) applied to a `log` entity.
- **Body measurement delete** — inferred to be flat `isHidden:true`, identical mechanics to exercise archive (§11, row 13) applied to a `measuredValue`.

An easy way to retire both inferences: perform each action once in the app and capture the PUT (see §9 — treat these as the first golden fixtures for those two tools).

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
- Inject `Authorization: Bearer <token>` (from TokenManager) and Strong's client headers, from captures: `X-Client-Platform: ios`, `X-Client-Version: 6.4.2`, `X-Client-Build: 8332`, `User-Agent: Strong iOS`, `Accept: application/json`, `Content-Type: application/json` (on writes).
- **Client version/build are configurable constants**, not hardcoded inline, so they can be bumped in one place. **Operational risk:** Strong may reject a stale client version at any time; if that happens, all traffic fails until these values are updated (no other code change needed). This is an accepted external dependency for a private-API client.
- Retries with backoff on 5xx / network errors (writes are retried only on connection failures where we know the PUT didn't land, to avoid duplicate mutations).
- On `401`: trigger one token refresh + retry via the single-flight refresh (§5.1), then surface a clear error.
- **Success detection is by HTTP status code** — PUT responses have an empty body.
- Optional `proxyUrl` passthrough (e.g. `http://localhost:9090`) so traffic can still be watched in Proxyman during development.
- Cookies (`ARRAffinity`/`ASLB*` load-balancer affinity) seen in captures are **not** required for auth (bearer token carries it); the client does not need to manage them, though a cookie jar is harmless if added later.

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

The Strong user document embeds these eight collections: `template`, `log`, `measurement`, `measuredValue`, `folder`, `tag`, `metric`, `widget`.

**Critical: `template` and `log` are SEPARATE collections.** A saved routine reads back in `_embedded.template` and is written to `_embedded.template`; a performed workout reads back in `_embedded.log` and is written to `_embedded.log`. They **share the same internal shape** (both carry `logType`, both nest `cellSetGroup → cellSet → cell`), but they are distinct collections in every sync page and every write envelope. Do not merge them in the snapshot or the builder. (`logType` is `TEMPLATE` on template entities and `WORKOUT` on log entities — a redundant discriminator; the *collection* is authoritative for routing writes.)

Shared nested shape (both `template` and `log` entities):
```
<template | log entity>                 ← logType: TEMPLATE (in template[]) | WORKOUT (in log[])
 └─ cellSetGroup                         ← one exercise instance
     │  _links.measurement → exercise definition ("measurement")
     └─ cellSet                          ← one set, OR a single REST_TIMER row
         └─ cell                         ← typed value {cellType, value, isHidden}
```
Only `log` (workout) entities carry `startDate`/`endDate` and (optionally) `_links.template` pointing back to the source routine.

**Terminology gotcha:** an **exercise definition** is stored in the `measurement` collection with `measurementType: "EXERCISE"`. A **body measurement** (bodyweight, body-fat, calories) is a `measuredValue`. These are different things despite the similar names.

### 4.2 Entities

| Collection | Meaning | Shape notes |
|---|---|---|
| `template` | Saved routine (`logType:TEMPLATE`) | Nested cellSetGroups. No `startDate`/`endDate`. Separate collection from `log`. |
| `log` | Performed workout (`logType:WORKOUT`) | Same nested shape as `template`, **plus** `startDate`/`endDate` and often `_links.template` back to its source routine. |
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

Interleave pattern (from captures): `set, rest, set, rest, …, set, rest` — each working set is **followed by** its own rest-timer cellSet, including a trailing rest timer after the last set. So N working sets ⇒ N working cellSets + N rest-timer cellSets, strictly alternating.

**Rest-timer value source:** the builder does not take rest as tool input. It reads `preferences.restTimer` from the snapshot — a map of exercise-definition-id → seconds (captures show a global default of `85`). For an exercise with no specific entry, use the user's default (the entry keyed by the user id). Rest seconds are stored as a **stringified integer** (`"85"`).

### 4.5 Weights & units

- Weights are persisted as **stringified kg floats** (e.g. `"13.6077711"` = 30 lb; `kg = lb × 0.45359237`).
- The user document reports unit preferences: `preferences.weightUnit` (`POUNDS`), `distanceUnit`, `lengthUnit`.
- **The server reads these preferences** and converts at the service boundary rather than hardcoding lbs. Tools accept/emit values in the user's display unit (lbs for this account) and echo both units where useful.
- `measuredValue.value` semantics are **type-dependent**:
  - `WEIGHT`: kg float (`90.718474` = 200 lb) — uses weight conversion.
  - `BODY_FAT_PERCENTAGE`: a **fraction** (`0.05` = 5%).
  - `CALORIC_INTAKE`: raw number (`2200`).
- **Open-enum rule differs by direction (important):**
  - **On re-send / read (passthrough):** unknown cell types and unknown `measurementTypeValue`s are carried through untouched and never fatal.
  - **On a user-supplied *write* value:** if the field's type is unknown (so its scaling/unit is unknown), the tool **refuses** and errors — it must not write a user number with a guessed scale. Better to reject than silently corrupt.
- **Passthrough integrity:** raw values on entities we are only re-sending (not changing) are preserved byte-for-byte (see §6.5) — we never re-round a value we didn't intend to edit.
- **Display precision:** when emitting a converted weight to the user, round to a sensible display precision (e.g. 0.1–1 lb) for readability, but this rounded value is **display-only** and never written back to an unchanged cell (§6.5).

### 4.6 Snapshot on disk

```jsonc
{
  "userId": "…",
  "continuation": "…",      // delta cursor: token from the last synced page (see §6.1)
  "syncedAt": "ISO-8601",
  "preferences": { "weightUnit": "POUNDS", … },
  "entities": {
    "template": { "<id>": { … } },   // logType:TEMPLATE — separate from log
    "log": { "<id>": { … } },        // logType:WORKOUT
    "measurement": { "<id>": { … } },
    "measuredValue": { "<id>": { … } },
    "folder": { "<id>": { … } },
    "tag": { … }, "metric": { … }, "widget": { … }
  }
}
```

**Retention:** `isHidden:true` (soft-deleted) entities are **kept** in the snapshot, not pruned. Reasons: (a) a later full-entity-replace write must re-send the entity's full child tree, and (b) reads filter `isHidden` out at the service layer. The snapshot is a faithful mirror of the account, hidden entities included.

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
- **Fallback:** if refresh fails, surface a clear "re-auth required — re-seed tokens" error. (Password-based auto re-login is intentionally deferred; see §13. Revisit only if re-seeding becomes painful.)
- **Never log** tokens or credentials.
- `deviceId` is a stable configured UUID (must match the one used when the seeded tokens were minted).

### 5.1 Concurrency, durability & recovery
The MCP client can issue overlapping tool calls, and the refresh token is single-use (rotates). Without care this bricks the session. Rules:

- **Single-flight refresh (mutex).** At most one `/auth/login/refresh` is in flight at a time. Concurrent callers that hit the ~60s-to-expiry threshold await the *same* refresh promise; they must never each send the (same, now-spent) refresh token. A 401 mid-request funnels through the same single-flight refresh.
- **Serialized write queue.** All mutations (§6.2) run through one queue — never two concurrent `PUT`s, and never two racing read-modify-write cycles on `snapshot.json`. Reads may run concurrently with each other.
- **Atomic persistence.** Both `token.json` and `snapshot.json` are written via write-temp-then-`rename()` (atomic on the same filesystem) so a crash never leaves a half-written file.
- **Crash-during-refresh window.** The server rotates the token remotely *before* it can persist locally. Order of operations: receive refresh response → **persist `token.json` atomically** → only then issue the retried request. This shrinks — but cannot fully eliminate — the window where a crash loses the rotated token. If it happens, the on-disk refresh token is spent and recovery is a manual re-seed (documented, accepted for a single-user local tool).
- **Refresh-token TTL is unknown.** The 20-min figure is the *access* token. The refresh token's own lifetime wasn't captured, so "alive indefinitely" assumes the server refreshes before the refresh token expires from idleness. Mitigation options (decide during build): a background timer that refreshes proactively even when idle, or simply accept idle-expiry → re-seed. v1 default: lazy refresh + documented re-seed on failure.
- **Re-seed precedence & spent-token guard.** "First run" = no readable `token.json`. On every later run, `token.json` is the source of truth. If it's missing/corrupt, the server falls back to the seeded env tokens **once**; if a refresh with those also fails (they may be spent), it **fails loudly** ("re-seed required") rather than retrying a spent token in a loop. The env seed is treated as a one-time bootstrap, not a durable fallback.
- **`logout` is never called** by the server — it would spend the tokens. It's documented in §11 only for completeness.

## 6. Sync engine

### 6.1 One loop, two entry points
Both walk pages of `GET /api/users/{id}/` with a fixed query: `limit=300` and the **exhaustive** include set
`include=template&include=log&include=measurement&include=widget&include=tag&include=folder&include=metric&include=measuredValue`
(all eight collections — see §4.1; omitting any means never syncing it). `deltaSync` adds `continuation=<stored cursor>`; `fullSync` omits it (start from the beginning).

- `fullSync()` — start with no continuation; follow each page's `_links.next` href (which carries the next `continuation` token), normalizing every entity into the snapshot.
- `deltaSync()` — same loop starting from the persisted cursor; apply only changed entities (including `isHidden` soft-deletes) onto the existing snapshot.

**Termination — stop when *either*:** (a) a page returns **all eight `_embedded` collections empty**, or (b) a page has **no `_links.next`**. Both have been observed as terminal; handle both.

**Which token becomes the persisted cursor:** the `continuation` carried by the **last page's `_links.next`** (the cursor that *would* fetch the next page). On the next run, resuming from that cursor returns an immediately-empty page when nothing changed — the normal caught-up case. If a page is terminal with no `next`, retain the previously-stored cursor. The cursor is only advanced on a fully successful page walk.

Full and delta sync are the **same algorithm** with a different starting cursor. If the stored cursor is rejected (e.g. 4xx), fall back to `fullSync()`.

### 6.2 Write flow (all mutations)
All mutations are **serialized** through a single write queue (see §5.1) so no two writes interleave.
1. `deltaSync()` first (usually one cheap empty page) so cross-links aren't stale.
2. Mutate the target entity in a working copy: client-generated UUIDs (v4) for new entities, bumped `lastChanged`, ISO timestamps. **Edits start from the entity's exact snapshot object** (see §6.5).
3. Build the envelope: `{ id: userId, strongAnalytics: false, _embedded: { …only changed collections populated, rest as [] } }`.
4. `PUT /api/users/{userId}`.
5. On 2xx: apply the same mutation to the local snapshot and persist (atomic write-temp-then-rename). On failure: surface error, snapshot unchanged.

**Envelope routing rule (from B1):** the target collection is chosen by entity kind, **not** by `logType` alone:
- saved routine → `_embedded.template`
- performed workout → `_embedded.log`
- exercise definition → `_embedded.measurement`
- body value → `_embedded.measuredValue`
- folder → `_embedded.folder`

A template create/delete also writes the affected `folder` (see §6.6). All other collections are sent as `[]`.

### 6.3 Workout building uses `cellTypeConfigs`
When logging/editing a workout, for each exercise the builder **looks up that exercise definition's `cellTypeConfigs`** to decide which cell types a set emits (e.g. `BARBELL_WEIGHT` vs `DUMBBELL_WEIGHT` vs `WEIGHTED_BODYWEIGHT`) and in what order. It does **not** hardcode a weight cell type.

- **Exercise identity is the definition id (UUID), not the name.** `strong_log_workout` input references each exercise by its `measurement` id. To make this ergonomic, `strong_list_exercises` (§7) returns ids alongside names, and callers resolve names → ids via that tool first. (Optional convenience: the tool may accept an exact-name match and resolve it internally, but it **errors on ambiguity or no match** rather than guessing.)
- **Not-found:** if a referenced exercise id isn't in the snapshot after the pre-write `deltaSync`, the tool errors (there's no `cellTypeConfigs` to build from) — it never fabricates a definition.
- **Cell value placement:** each set's `{reps, weight, rpe?}` is mapped onto the config's cell types by role (weight → the config's weight-type cell, reps → `REPS`, rpe → `RPE`). A set that omits `rpe` emits an `RPE` cell with `value: null` (matching captures). Weight is converted display-unit → kg (see §4.5); a config whose weight cell type is unknown triggers the refuse rule in §4.5.

### 6.4 Soft-delete is generic
"Delete" is never a hard delete. It's a `PUT` flipping `isHidden: true`:
- **Nested entities (templates & workouts):** cascade `isHidden: true` to the entity **and every** cellSetGroup / cellSet / cell.
- **Flat entities (exercises & measuredValues):** flip `isHidden: true` on the single entity.
- **Templates additionally:** remove the deleted template's `_link` from its containing `folder` and re-send that folder in the same PUT (see §6.6), so no folder points at a hidden template.

One `softDelete(entity)` routine handles the cascade/flat distinction; template deletion wraps it with the folder-link fixup.

### 6.5 Full-entity-replace edits preserve untouched values verbatim
Updates (`strong_update_workout`, `strong_update_template`, `strong_update_exercise`) are full-entity replacements: the entire entity, including cells the user did **not** touch, is re-sent. To avoid corrupting stored values:

- The working copy is a **deep clone of the exact snapshot entity** (which holds Strong's original raw strings, e.g. `"13.6077711"`).
- Only the specific cells named in the edit are rewritten (display-unit → kg at that point).
- Every other cell keeps its **original raw string byte-for-byte** — no kg→display→kg round-trip is ever applied to a cell we aren't editing.

This makes the §4.5 "passthrough integrity" promise enforceable: a round-trip conversion touches *only* cells the user explicitly changed. (Consequence: an edit is only safe if the entity is present in the snapshot; if it isn't, `deltaSync`/`fullSync` must fetch it first, else the tool errors rather than reconstructing from lossy display values.)

### 6.6 Folder membership maintenance
`folder` entities hold an ordered list of template `_links`. Therefore:
- **`strong_create_template`** takes an optional target folder (default: the user's "My Templates" folder, matched by its well-known id suffix `-my-templates`) and an optional insert position (default: append). The new template's `_link` is added to that folder, and the folder is re-sent in the create PUT.
- **`strong_delete_template`** removes the template's `_link` from whatever folder contains it and re-sends that folder.
- If no folder contains/should-contain the template, the folder collection is sent as `[]`.

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
- `strong_log_workout` — create a completed workout: name, optional source template id, exercises referenced **by definition id**, each with sets `{reps, weight, rpe?}`. Builder emits cellSetGroups + alternating rest-timer cellSets (§4.4) using each exercise's `cellTypeConfigs` (§6.3); converts display units → kg. Writes to `_embedded.log`.
- `strong_update_workout` ⚠️*inferred shape (B2)* / `strong_delete_workout` — full-entity replace (§6.5) / cascading soft-delete.
- `strong_create_template` (optional target folder + position, §6.6) / `strong_update_template` / `strong_delete_template`. Writes to `_embedded.template` (+ `folder`).
- `strong_log_measurement` — body metric entry; type-aware value conversion, refuses unknown types (§4.5).
- `strong_delete_measurement` ⚠️*inferred shape (B2)* — flat soft-delete.
- `strong_create_exercise` — custom exercise: name, `cellTypeConfigs`, tags, notes/instructions.
- `strong_update_exercise` / `strong_archive_exercise` (soft-delete; no hard delete exists).

### Tool conventions
- Every write requires an explicit target and returns a summary of what changed — no silent guessing about which entity to mutate.
- Weight inputs/outputs are in the account's display unit; responses echo kg where helpful.
- Exercises are referenced by definition **id**; resolve names via `strong_list_exercises` first (§6.3).
- Tools marked ⚠️*inferred shape* should have their real PUT captured and turned into a golden fixture before shipping.

## 8. Error handling

- **Auth:** refresh → re-login fallback → clear "re-auth required" error. 401 mid-request triggers one refresh+retry.
- **Sync drift:** rejected cursor ⇒ automatic full re-sync. If you also edited in the app, the pre-write `deltaSync` pulls those changes first.
- **Writes:** status-code based; on non-2xx, snapshot is left unchanged and the error is surfaced with context.
- **Unknown enums** (cell types, measurement types): passthrough on re-send/read; **refuse** on a user-supplied write value (§4.5).
- **Never** log tokens, passwords, or the full bearer.

### 8.1 Known limitations (accepted for single-user v1)
- **Write-race TOCTOU.** Between the pre-write `deltaSync` (§6.2 step 1) and the `PUT` (step 4) there is a window where a concurrent edit in the phone app to the *same* entity would be clobbered by last-write-wins. Acceptable for a single user unlikely to edit both surfaces simultaneously; not defended against beyond the pre-write sync.
- **Local-vs-canonical drift.** Step 5 applies the mutation locally, but the server may canonicalize the entity (e.g. backfilling `instructions.en`, observed in captures). The local copy can differ from server truth until the next `deltaSync` re-pulls it. This is benign because the next delta re-delivers our own write; **the normalize/apply step must be idempotent** (re-applying an entity we already have is a no-op replace by id).

## 9. Testing strategy

- **Unit:** HAL normalization (firehose → snapshot), envelope builder + routing rule (§6.2), unit conversion (lb↔kg, body-fat fraction, per-type measuredValue), soft-delete cascade, folder-link fixup (§6.6), byte-for-byte preservation on edits (§6.5), workout builder w/ `cellTypeConfigs`. Driven by the captured fixtures in §11.
- **Golden fixtures:** each captured curl becomes a fixture; builders must reproduce the observed PUT body (modulo generated UUIDs/timestamps) from equivalent inputs. Includes the two ⚠️*inferred* shapes once captured.
- **Mock/replay HTTP layer (required, not optional):** record the captured pages/responses and replay them so the **highest-risk paths are covered offline & deterministically** — multi-page pagination + both termination conditions (§6.1), cursor-rejection → full resync, 401 → single-flight refresh → retry, and the concurrency/durability behavior of §5.1 (single-flight refresh, serialized writes, atomic rename, crash-window ordering) with a fake clock.
- **TokenManager:** refresh rotation persistence, expiry threshold, single-flight coalescing, spent-token guard & re-seed precedence (§5.1).
- **Integration (optional, gated behind an env flag):** live through the Proxyman proxy, create→read→delete round-trips. ⚠️ Note: there is **no hard delete** (§6.4), so every live run permanently accumulates hidden junk in the account. Use a **dedicated throwaway test account**, not the primary one.

## 10. Configuration

Env / config file:
- `STRONG_ACCESS_TOKEN`, `STRONG_REFRESH_TOKEN` — seeded token pair (required for v1)
- `STRONG_DEVICE_ID` — must match the `deviceId` used when the seeded tokens were minted (read it from the captured `/auth/login` or `/auth/login/refresh` request body; a mismatch silently breaks refresh)
- `STRONG_DATA_DIR` (default `~/.strong-mcp`)
- `STRONG_PROXY_URL` (optional, dev)
- Unit override (optional; default = account preference)

Seeded tokens are read on first run and thereafter the persisted `token.json` is the source of truth (it holds the rotated refresh token). Password-based config (`STRONG_USERNAME`/`STRONG_PASSWORD`) is intentionally **not** part of v1.

## 11. Verified endpoint reference (captured)

All captured via Proxyman against the real account. Base: `https://back.strong.app`. This table lists **only actually-captured** traffic; the two inferred shapes (workout update, measuredValue delete — see §2) are deliberately **not** here and must be captured before their tools ship.

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

## 12. Build phases

The write path carries essentially all the correctness risk (B1–B3, §5.1, §6.5). Build in two phases so the auth+sync foundation stabilizes before mutations depend on it:

- **Phase 1 — foundation + reads (low risk, immediately useful):** HTTP client, TokenManager (§5/§5.1), Sync Engine + Snapshot Store (§6.1), HAL normalization, and all read tools (§7). Ship and use this alone to analyze history.
- **Phase 2 — writes (all correctness risk):** envelope builder + routing (§6.2), byte-for-byte edits (§6.5), soft-delete + folder maintenance (§6.4/§6.6), workout builder (§6.3), and the write tools. Within Phase 2, build in captured-confidence order: **templates → workouts (log/delete) → measurement log → exercises**, and capture the two ⚠️*inferred* shapes before their tools ship.

## 13. Out of scope (v1)

- Multi-user / hosted deployment (single local user only).
- **Password-based auth / auto re-login.** v1 seeds a token pair and relies on refresh; if refresh ever fails you re-seed. Storing the password for unattended re-login is deferred and revisited only if re-seeding becomes painful.
- Deep modeling of `metric`, `widget`, `folder` reordering beyond what template CRUD needs.
- Per-collection read endpoints (`/api/logs/{userId}`, etc.) — continuation sync is the backbone; these are a possible later optimization.
- Distance/time/cardio-specific cell handling beyond generic passthrough (revisit when such data appears).
