# AGENTS.md

Guidance for AI coding agents (and humans) working on Spicy Studio. Read this before changing code.
User-facing documentation lives in [README.md](README.md).

## What this is

A self-hosted, multi-user web studio for AI image/video generation. It talks to paid providers
(SpicyAPI over REST, Higgsfield over its MCP server), stores results locally, and saves files to each
user's NAS (SMB) or a server folder. It runs as two Docker containers (`db` Postgres, `studio` app).

**Generations cost real money.** Never trigger a real (paid) generation, retry or quote loop against a
real provider account from tests or scripts without the owner's explicit OK. Use the Mock provider
(`MOCK_PROVIDER=1`) and quotes / `get_cost` (free) instead.

## Repository layout

```
compose.yaml              db + studio services; .env supplies POSTGRES_PASSWORD, PORT, DATA_PATH, EXPORT_ROOT, APP_SECRET
Dockerfile                multi-stage: build server + web, runtime has ffmpeg and smbclient
server/                   Node 22 + TypeScript API (ESM; imports use .js suffixes)
  migrations/NNN_*.sql    versioned SQL, applied in order on boot, each in a transaction
  src/index.ts            Fastify setup, route registration, boot: waitForDb → migrate → seedAdmin → bootstrap → startWorker
  src/config.ts           env-based config
  src/db.ts               pg pool, q/one/tx helpers, migrate()
  src/auth.ts             sessions (cookie `sid`, sha256-hashed tokens), argon2id passwords, admin guard, setup/login/password routes
  src/events.ts           per-user Server-Sent Events (/api/events) + notifyChange(userId)
  src/providers/          Provider interface (types.ts), spicyapi.ts, higgsfield.ts, mock.ts, registry.ts (per-user instances)
  src/routes/             workspace.ts (workspaces, folders, refs, elements), generations.ts (generate, assets, save, download),
                          providers.ts (status, keys, OAuth, models, favorites, balances, quote), admin.ts (my settings, users),
                          agents.ts (agent API keys), dto.ts
  src/mcp/                server.ts (MCP endpoint /mcp + /api/agent/files), tools.ts (the tools), resolve.ts (pure helpers)
  src/services/           generations.ts (request building + worker), media.ts (content-addressed store, thumbs, downloads),
                          access.ts (ownership guards), saveTargets.ts (SMB/local saving), exports.ts (file naming, local save),
                          metadata.ts (lossless metadata stripping), prompt.ts (@mentions), secrets.ts (AES-GCM),
                          providerSettings.ts (per-user provider credentials/state), bootstrap.ts (code-level upgrades)
  test/                   vitest unit tests (no DB needed)
web/                      React 19 + Vite + Tailwind 4 SPA (PWA: public/manifest.webmanifest, public/sw.js)
  src/App.tsx             auth gate, Studio shell, setup banner
  src/lib/                api.ts (fetch wrapper), queries.ts (TanStack Query hooks, SSE live updates), store.ts (zustand UI state + draft),
                          actions.ts (recreate, animate, save, upload…), models.ts, types.ts (mirrors server DTOs), fileInput.ts (drop/paste)
  src/components/         Header, Gallery, Viewer (desktop) / MobileViewer (gestures), create/* (CreateBox, ModelPicker, RefTray,
                          PromptInput, SettingsControls), RefPicker, Library (references + elements), SettingsModal, UsersAdmin, ui.tsx
```

## Commands

```bash
npm install                       # workspaces: server, web
npm run dev:server                # API on :3000 (needs Postgres via DATABASE_URL)
npm run dev:web                   # Vite on :5173, proxies /api and /media to :3000
npm test                          # vitest (server/test)
npx tsc -p server --noEmit        # typecheck server
npx tsc -p web                    # typecheck web (noEmit in tsconfig)
docker compose up -d --build      # build and run the stack
```

Always typecheck both packages and run the tests before finishing a change.

### Throwaway stack for UI / integration checks

Run a second, isolated stack (own project name, port, data dir, DB volume) with the free Mock provider,
never against the real deployment's database:

```bash
COMPOSE_FILE=compose.yaml PORT=3100 DATA_PATH=/tmp/st-data EXPORT_ROOT=/tmp/st-exports MOCK_PROVIDER=1 \
  docker compose -p studio-uitest up -d --build
# … test via http://localhost:3100 (POST /api/auth/setup creates the first admin) …
COMPOSE_FILE=compose.yaml PORT=3100 DATA_PATH=/tmp/st-data EXPORT_ROOT=/tmp/st-exports \
  docker compose -p studio-uitest down -v --rmi local
```

To rehearse a migration, restore a `pg_dump` of the real DB into that stack's `db` first. Don't call paid
provider endpoints from it, and don't use a copied Higgsfield OAuth login there for anything that could
refresh tokens (it can rotate the real refresh token).

On Windows Git Bash, prefix `docker compose exec …` commands that contain container paths with
`MSYS_NO_PATHCONV=1`.

## Architecture

### Request flow and generation worker

1. `POST /api/generations` → `createGenerations()` validates input (`buildRequest`), inserts one
   `generations` row per batch item (`status = pending`, `resolved_input` = prompt after @mention
   resolution + ref ids per field + native elements), then submits items sequentially.
2. `submit()` uploads references to the provider once per file (`provider_uploads` cache, keyed by user,
   file and provider; entries can expire) and calls `provider.create()`, storing the provider task id.
3. The worker (`startWorker`) polls due rows every 2 s (`next_poll_at`, backoff), downloads finished
   results into the media store (`storeFromUrl`, stall timeout), inserts `assets`, marks `succeeded`.
   Transient errors are retried with `error = 'Retrying: …'`; jobs time out after 3 h.
4. On restart, `pending` rows without a task id are resubmitted only for SpicyAPI (idempotency key);
   other providers are marked failed so nothing is charged twice.
5. Every change calls `notifyChange(userId)` (also done automatically for successful non-GET `/api/*`
   requests). The web app holds an SSE connection and invalidates its queries on `change`.

`assets.created_at` is the generation's submission time (minus idx µs) so the timeline follows
submission order, not completion order.

### Providers

`server/src/providers/types.ts` defines `Provider` (`listModels`, `getModel`, `quote`, `upload`,
`create`, `task`, `balance`, `configured`) and the normalized `ModelInfo`:

- `fields`: settings (enum/boolean/number/integer/string/text, labels, units, `advanced`).
- `refFields`: media inputs (`kind` image/video/audio, `max`, `required`, `primary`, `array` when the
  provider wants a list even for one item).
- `nativeElements`: the provider takes `@elements` itself (see below).

The UI is built entirely from `ModelInfo`; adding a provider needs no UI changes. Register new
providers in `registry.ts`. Instances are per user (`providersFor(userId)`), because credentials are per
user; `dropProviders(userId)` clears the cache.

**SpicyAPI** (`spicyapi.ts`): responses are `{code, msg, data}`; `request()` throws `ProviderError` with
`friendlyError()` messages. Models come from `/models?includeSchema=1` (JSON Schema with `x-ui` hints) and
are normalized by `normalizeSchema()`. Notes:
- Quotes (`/jobs/quote`) require filled media inputs. For pricing only, `quoteGeneration()` fills empty
  image inputs with a grey placeholder (`media.ts: ensureQuotePlaceholder`) uploaded once per user.
  Required video/audio inputs decide the price, so there is no quote until they're filled.
- References over 10 MB are re-encoded (`fitImageUnder`).
- Kling O3 `elements` (2–4 images each, "4K only") → `nativeElements` with `requiresSetting`.

**Higgsfield** (`higgsfield.ts`): an MCP client (`@modelcontextprotocol/sdk`, Streamable HTTP) with
OAuth (dynamic client registration + PKCE); tokens are stored per user in `provider_settings`.
Notes:
- Catalog from `models_explore`; generation via `generate_image` / `generate_video` with
  `params.medias[{value, role}]`. The job id is at `results[].id` (`extractJobId`). Status comes from
  `jobs_wait` with `timeout_seconds: 0`.
- Higgsfield may answer with a preset recommendation instead of a job: `generateCall()` repeats the call
  with `declined_preset_id` (also for `get_cost` quotes).
- Always send `use_unlim: false` (pay with credits; never spend a user's free allowance implicitly).
- Images over 10 MB are shrunk before upload ("Input file is too large" otherwise). Don't reuse job ids
  across generations.
- Higgsfield Elements: for models in `ELEMENT_MODELS`, `@name` mentions become `<<<element_id>>>`.
  The element is created once in the user's Higgsfield account via `show_reference_elements` and cached
  in `provider_elements` by a signature of name/description/files. Higgsfield can't edit elements, so a
  changed element creates a new one. Quotes never create elements. Kling 3.0 needs a `start_image`.

**PoYo** (`poyo.ts`): REST (`https://api.poyo.ai/api`, Bearer key): `POST /generate/submit {model, input}`,
`GET /generate/status/{id}` (`not_started|running|finished|failed`, `files[].file_url`, `credits_amount`),
`POST /common/upload/stream` (multipart; images kept 72 h, videos 24 h → `expiresAt`), `GET /user/balance`.
PoYo has no catalog endpoint: `server/scripts/poyo-catalog.ts` (`npm run poyo:catalog -w server`) builds
`src/providers/poyo-catalog.json` from the pricing page's embedded product data (names, model ids, price tiers)
and each doc page's OpenAPI `input` schema. Re-run it to pick up new models and commit the diff. At runtime the
schemas go through SpicyAPI's `normalizeSchema` after `simplify()` (preset branch of `size` unions; `n`, links
and documents dropped); `forVariant()` shapes each variant (plain vs `-edit`, text- vs image-to-video). There
is no quote endpoint: `estimateCredits()` picks the best-matching published tier (× seconds when per second).

Provider API-key routes are generic (`PUT/DELETE /api/providers/:id/key`, validated with `balance()`), and a
provider's 401 is sent to the browser as 400 so a wrong provider key never signs the user out.

**Mock** (`mock.ts`, only with `MOCK_PROVIDER=1`): free, local files, configurable failures.

### Environment library

`environments` rows belong to a user (not a workspace) and are shared by all of that user's workspaces
(`routes/environments.ts`). Generations only reference workspace refs, so using an environment creates a
workspace ref with `source_environment_id` (`POST /api/environments/use`, reused on later picks). Those
refs are hidden from the per-workspace reference lists. The link has no foreign key on purpose: deleting or
moving an environment keeps refs made from it hidden (elements and past generations still use them).
Moves: `POST /api/refs/bulk {action: 'environments'}` (ref → library, the ref stays linked),
`POST /api/environments/move` (library → a workspace's Model refs/Uploads), `POST /api/environments/from-assets`.
Uploads dedupe by file. File cleanup (`collectGarbage`) and the media guard both account for `environments`.
Every upload in the web app goes through `actions.ts: uploadInBatches` (4 files per request, progress
pill, per-file retry); the server's multipart cap (500 files, 200 MB per file) is only a safety limit,
and files over it are dropped silently by the multipart parser, so never upload big selections in one request.

### Auto router

`services/router.ts` groups every connected provider's models into families by name (`familyName`: strips
variant suffixes after " · ", noise words, "v3"→"3", "3.0"→"3"; special-purpose variants never route).
A user's picked families (`user_settings.router.models`) are served as virtual models `auto:<family key>` in an
"Auto" group first in `/api/models`. Their settings/inputs are generic (`aspect_ratio`, `resolution`,
`duration`, `audio`; refs `images`/`start`/`end`/`videos`/`audio`). On quote/generate, `route()` translates
the box to each candidate (`translateSettings`: closest option; `translateRefs`: by role, null if the model
can't take the inputs or misses a required one), prices them with the normal quote path, converts credits to
dollars (user's value → `Provider.unitValueUsd` → fallback) and picks the cheapest whose balance covers it.
Uncensored and regular versions are separate families (key suffix `.uncensored`, name "… · Uncensored"), so
routing never crosses between them. `isUncensored(model, marks)`: the user's mark (`user_settings.router.marks`,
per model id) → `ModelInfo.mature` from the provider (SpicyAPI `mature`, PoYo "Uncensored" tag, Higgsfield's
hand-kept `UNCENSORED` list since its catalog has no flag) → the name. Safety-checker switches are turned off
when routing.
Routed generations keep the Auto pick in `resolved_input.auto`; the detail API returns it as
`modelId/settings/refSlots` (what Recreate/Animate restore) and what ran as `routed`.
Nothing is provider-specific: a new provider is routed automatically once its models are named like others.
`MOCK_PROVIDER=1` registers two mocks (Mock in credits, Mock B in USD with a small balance) for testing.

### Agents (MCP server)

`/mcp` is a stateless Streamable HTTP MCP server (`mcp/server.ts`: a fresh low-level `Server` + transport per
request, JSON responses, no sessions). Auth is `Authorization: Bearer sst_…` (`services/apiTokens.ts`: sha256
stored, shown once, `last4` for display). `registerAuth` accepts bearer tokens **only** on `isAgentPath`
(`/mcp`, `/api/agent/*`) and cookies only elsewhere, so a key can never reach settings, provider keys or admin.
Each key (`api_tokens`) has `perms` (`generate`, `folders`, `upload`, `presets`, `save`, `delete`; listing is
always allowed) and an optional `workspace_ids` allowlist. Tools check `requirePerm` and scope every lookup
through `allowed()`/`workspaces()` plus the usual ownership guards; foreign or disallowed ids are "not found".
Tools take names or ids (`resolve.ts: pickOne`; an Auto model wins a name tie) and reuse the studio's code:
`createGenerations(…, apiTokenId)` (stored in `generations.api_token_id`, shown as "Made by"), `quoteGeneration`,
`services/assets.ts` (save/move/delete, shared with the routes), `refFromAsset`, `useEnvironment`. Files are
served by `GET /api/agent/files/:id[?clean=1]` (stripped on the fly); URLs use `PUBLIC_URL` or the request host.
Tool calls go around the `/api` change hook, so tools call `notifyChange` themselves. Test against the throwaway
stack with the SDK `Client` (Mock providers only).

### Prompt assistant

`services/promptAssist.ts` + `routes/assist.ts`: rewrites a prompt through OpenRouter (`/chat/completions`, default
`x-ai/grok-4.7`). Key (encrypted) and preferences (`model`, `houseRules`, `showRefs`) live in `provider_settings` under
`openrouter`; each workspace can add its own preferences (`workspaces.prefs.assistRules`, edited in Workspace settings),
sent after the general ones and winning where they disagree. The pure parts are in `services/promptRewrite.ts`: the system prompt, `describeTarget` (model + settings),
`tokenTable` (what each `@` token is; only the primary input — `generations.ts: primaryRefField` — is addressable as
`@imageN`), `checkTokens` (every original token kept, nothing invented except existing `@imageN`; one retry with the
problem named, then warnings) and `cleanAnswer`. With `showRefs`, references and up to 3 photos per mentioned element
are sent as 768 px JPEGs (max 12). The UI (`create/PromptAssist.tsx`) shows the rewrite for review; using it keeps the
user's words in `draft.promptOriginal`, sent as `originalPrompt` and stored in `resolved_input.original` (detail:
`originalPrompt`; Recreate restores both). Auto enhance (`GenerateInput.enhance`, `draft.autoEnhance`): rows start as status `enhancing` (in `ACTIVE`) with
`resolved_input.enhance = {showRefs, done}` and `original`; `enhanceGroup(batch_group)` rewrites once per batch for the
concrete (routed) model, rebuilds the request, sets `pending` and submits. Failures fail the batch (Retry rewrites
again unless `done`); `startWorker` resumes `enhancing` groups after a restart (nothing is charged before).
Agents get the same rewrite through the MCP tool `enhance_prompt` (needs `generate`; `generate` takes `original_prompt`).
`OPENROUTER_BASE` points at a fake server for tests; never call the real one
from tests.

### Presets

`presets` (`routes/presets.ts`) store a create-box state per workspace and modality: model id, prompt,
settings, ref ids per field, folder, batch. Saving validates refs/folder against the workspace; loading
(`actions.ts: loadPreset`) works like Recreate and skips references deleted since. Names are unique per
workspace + modality. UI: `components/create/Presets.tsx`. The store keeps the active preset per modality
with a snapshot of the box (`presetSnapshot`); a different box shows it as edited and offers Update. Presets
are never saved automatically. Recreate, Animate and switching workspace clear the active preset.

Folder rule: while a folder is open in the sidebar, it is the create box's folder. Opening it selects it,
and Recreate, Animate and loading a preset keep it (`actions.ts: folderFor`; Unsorted = no folder).

### @mentions and elements

`services/prompt.ts: resolvePrompt()` turns `@image2` into `image 2`. For normal models `@Mia` attaches
the element's photos to the primary image field and becomes `image 3, image 4`. For models with
`nativeElements` the mention stays `@Mia` and the element is passed to the provider (`CreateRequest.elements`).

### Multi-user isolation (security-critical)

- Ownership hangs off `workspaces.user_id`. Refs, elements, folders, generations and assets are reached
  through their workspace. Per-user tables: `provider_settings`, `favorite_models`, `provider_uploads`,
  `provider_elements`, `environments`, `user_settings`, `sessions`.
- **Every route must check ownership** with `services/access.ts`: `ownWorkspace`, `ownRow(userId, table, id)`,
  `ownedIds`. Foreign ids respond **404** (not 403) so ids can't be probed. Bulk endpoints silently drop
  foreign ids.
- `/media/*` is guarded by `registerMediaGuard`: a file is served only if it belongs to one of the
  user's refs/assets/thumbnails.
- SSE channels are per user (`change:${userId}`).
- Admin routes call `requireAdmin` (404 for non-admins). Keep at least one admin; admins can't delete
  themselves. Deleting a user cascades their rows, then garbage-collects unreferenced media files.
  Files on their save location are never touched.

### Secrets and auth

- Passwords: argon2id (`@node-rs/argon2`, m=19456, t=2, p=1); legacy scrypt hashes are verified and
  upgraded on login. Password changes and admin resets revoke sessions.
- Session cookie `sid`: random token, stored as sha256; logins persist indefinitely.
- Provider credentials and SMB passwords are encrypted with AES-256-GCM (`services/secrets.ts`, `v1:`
  prefix; JSON sealed as `{enc}`), keyed by `APP_SECRET` or `data/app.key` (generated, mode 0600).
  Never return secrets from the API: mask them (`hasPassword`, `Key …1234`).
- SMB uses `smbclient` with a temporary auth file (mode 0600, deleted afterwards). Never put
  credentials on a command line.

### Media and saving

- `media.ts`: content-addressed store under `DATA_DIR/media` (sha256 path), thumbnails via sharp and
  ffmpeg, HEIC→JPEG, size limits. Downloads use a 30 s stall timeout plus a 15 min cap.
- Trim: `services/trim.ts` (`POST /api/assets/:id/trim {start, end}`) re-encodes the range with ffmpeg (libx264
  CRF 16 + AAC; re-encoding makes the cut frame-accurate, stream copy would snap to keyframes) into a **new asset**
  in the same generation and folder, timestamped 1 µs after the original (computed in SQL: JS dates drop µs).
  UI: `components/TrimModal.tsx` (handles, per-frame loop of the selection, I/O/Space keys).
- Save: `saveTargets.ts: saveForUser()` writes to the user's target (`local` under `EXPORT_ROOT`, or `smb`)
  in the workspace's image/video subfolder, with collision-safe names (`exports.ts: savedName`).
  Optional lossless metadata stripping is in `metadata.ts`.

### Database and migrations

- Plain SQL via `pg` (`q`, `one`, `tx`); no ORM. Use parameters, never string interpolation of values.
  Add explicit casts where Postgres can't infer types (e.g. `$4::int * interval '1 microsecond'`).
- Schema changes: add a new `server/migrations/NNN_name.sql`. **Never edit an applied migration.**
  Migrations must be safe on existing data (backfill before `set not null`, keep them additive when
  possible). Code-level upgrades that need JS (e.g. encrypting old values) go in `services/bootstrap.ts`
  and must be idempotent.
- Back up before deploying a migration:
  `docker compose exec -T db pg_dump -U studio -d studio -Fc > backup.dump`.

## Web app conventions

- Server state lives in TanStack Query (`lib/queries.ts`, `keys`). UI state and the create-box draft live
  in the zustand store (`lib/store.ts`). Invalidate queries instead of patching ad hoc. Live updates
  arrive through SSE.
- `lib/types.ts` mirrors server DTOs (`routes/dto.ts`). Keep them in sync.
- Mobile matters as much as desktop: test at phone width (375 px), use safe-area classes (`pt-safe`,
  `pb-safe`), large touch targets, no horizontal overflow. The installed PWA can't use backdrop blur on
  sticky headers (iOS renders it washed out).
- Dark theme only; colors come from Tailwind theme tokens in `index.css` (`bg-panel`, `text-muted`,
  `accent`…).
- Reuse the shared pieces: `MediaTile`, `Preview`, `AudioFace` (RefPicker.tsx), `MoveMenu` (the one "Move to"
  button for any selection), `Modal`, `Button`,
  `Segmented`, `Field` (ui.tsx), `useFileDrop` / `usePasteFiles`.

## Code style

- TypeScript strict, ESM. Match the surrounding code: short functions, comments that explain *why*,
  user-facing error messages written as plain, actionable sentences (`ProviderError(message, status)`).
- Prefer small, focused changes. Don't add dependencies without a clear need.
- Add unit tests in `server/test/` for parsing/normalization logic (provider schemas, prompt
  resolution, secrets, SMB parsing…). Tests must not need a database or network.

## Deployment checklist

1. Typecheck both packages and run `npm test`.
2. If there's a migration: back up the database; rehearse on a throwaway stack with a restored copy.
3. Check nothing is mid-generation (`select count(*) from generations where status in
   ('pending','queued','running','saving')`). The worker resumes after a restart, but avoid interrupting
   submissions.
4. `docker compose up -d --build studio`, then check `docker compose logs studio` and `/healthz`.

## Git

- Never commit `.env`, `data/`, `exports/`, `Pictures/`, dumps or any credentials. The repository is public.
- Commit messages describe the change. Don't add AI attribution or co-author trailers.
