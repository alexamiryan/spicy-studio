# Spicy Studio

A self-hosted, multi-user studio for AI image and video generation, in the spirit of
Higgsfield's web app: workspaces per character or project, reusable references and
`@elements`, one-click recreate, folders, batch generation, live cost estimates, and
one-click saving to a NAS. Dark mode, works on desktop and phones (installable as a PWA).

Providers:

- **[SpicyAPI](https://spicyapi.ai)**: 150+ image and video models with an API key.
- **[PoYo](https://poyo.ai)**: ~100 image and video models (Seedream, Nano Banana, Kling, Wan, Veo, Seedance,
  Flux…) with an API key, paid with PoYo credits.
- **[Higgsfield](https://higgsfield.ai)**: your Higgsfield account through its MCP server
  (OAuth sign-in, paid with your Higgsfield credits). Gives access to models such as
  Seedream 4.5, Kling 3.0 and Seedance 2.0.

New providers plug in behind one interface (see [AGENTS.md](AGENTS.md)).

## Features

- **Auto models**: pick the models you use (Settings → Auto models). They appear at the
  top of the model picker; each generation goes to the provider where it's cheapest right now and your balance
  covers it (credit prices are compared in dollars; set what a Higgsfield credit is worth on your plan).
  Uncensored and regular versions are separate Auto models (e.g. "Seedance 2.5" and "Seedance 2.5 · Uncensored"),
  so a generation never switches between them. Providers report which is which where they can; for Higgsfield,
  which doesn't, mark versions yourself in Settings → Auto models.
- **Agents (MCP)**: AI agents (e.g. Hermes) generate through the studio over MCP, with folders, Auto models,
  references, presets and saving. One key per agent, each with its own permissions and workspaces. See
  [Connecting agents](#connecting-agents-mcp).
- **Setup guide**: new accounts get a short wizard on first sign-in (providers with sign-up links, first workspace,
  save location, Auto models and prompt assistant); run it again from Settings → General.
- **Workspaces** keep generations, folders, references and elements separate, e.g. one per influencer.
- **Create box** built from each model's own schema: model picker with search and favorites,
  image/video/audio inputs (start/end frames, reference images, videos, audio), settings, folder and
  batch size (1–8; each item is its own provider job). The Generate button shows the price before you
  spend anything (dollars for SpicyAPI, credits for Higgsfield).
- **References**: upload, drag and drop or paste images; mark canonical shots as **Model refs**;
  turn any result into a reference. Mention them in prompts as `@image1`, `@image2`…
- **Environments**: a personal library of real-location photos (rooms, streets, cafés…) shared by all
  your workspaces. Upload once, then pick them as references anywhere (create box → Environments).
  Select photos anywhere and use **Move to** to file them in Model refs, Uploads or Environments (from the
  timeline: a folder, Model refs or Environments).
- **Elements**: named groups of references (`@Mia`). Mentioning one attaches its photos, or, on
  models that support it (Kling O3 on SpicyAPI; Kling 3.0, Seedance 2.0, Seedream and others on
  Higgsfield), passes it to the provider as a native element/character.
- **Presets**: save the create box (model, prompt, settings, references, folder, batch) under a name such as
  "Mirror selfie at home" and load it with one tap. Per workspace, separate for photos and videos.
- **Recreate** loads a result's prompt, model, settings and references back into the create box;
  **Animate** turns a photo into a video with your last video settings.
- **Library and timeline**: infinite grid with photo/video filters, folders, multi-select, move,
  delete (Shift+click or **Range** selects a range), unseen markers, a full-screen viewer (keyboard shortcuts on desktop, Photos-style gestures
  on phones), and live updates across devices.
- **Prompt assistant** (✨ in the prompt box): write what you want as usual; an LLM through
  [OpenRouter](https://openrouter.ai) (Grok 4.7 by default) rewrites the action into clear, literal instructions for the selected model and its
  settings (it never re-describes your references, which the model already sees), keeping every `@image`/`@element` link and its role (checked, with one automatic retry). Review it, use it,
  or go back to your words (kept with the generation for Recreate). Optional: let it see your references; standing
  preferences in Settings → Prompt assistant, plus per-workspace ones (e.g. an influencer's look) in Workspace settings.
  **Auto** (under ✨) skips the preview: each generation starts right away with an "Enhancing prompt" step (one
  rewrite per batch, for the model Auto picked), then runs; Recreate and Animate restore the switch.
- **Trim** (videos, `T`): drag the start and end, preview the selection on a loop, and save it as a new result
  next to the original (frame-accurate; the original stays).
- **Save** copies a result into the workspace's folder on your save location: an **SMB share**
  (e.g. a NAS) or a folder on the server. Optionally strips EXIF/XMP/IPTC/C2PA metadata losslessly.
  **Download** saves to the device (share sheet on iPhone).
- **Multi-user**: the first account is the admin; users are fully isolated, each with their own
  provider accounts, save location and data. Passwords are hashed with argon2id; API keys, OAuth
  tokens and SMB passwords are encrypted at rest.

## Quick start

Requirements: Docker with Compose.

```bash
git clone https://github.com/alexamiryan/spicy-studio.git
cd spicy-studio
cp .env.example .env      # set POSTGRES_PASSWORD (and EXPORT_ROOT for server-folder saving)
docker compose up -d --build
```

Open <http://localhost:3000> and create the admin account. Then, in **Settings**:

- **Providers → SpicyAPI** / **PoYo**: paste your API key (PoYo: poyo.ai/dashboard/api-key).
- **Providers → Higgsfield**: *Connect Higgsfield* and sign in. Do this from `http://localhost:3000`
  or an HTTPS address: Higgsfield's sign-in may refuse to redirect back to a plain-HTTP LAN address.
  Once connected it works from every device. Generations are always paid with credits, never with
  free/unlimited allowances.
- **Save location**: an **SMB share** (server, share, optional folder, username, password; *Test
  connection* writes and removes a probe file) or a **Server folder** (a subfolder of `EXPORT_ROOT`).
  Each workspace saves into its own image/video subfolders, set in the workspace's settings.
- **Users** (admins): create, rename, change role, reset password, delete. Deleting a user deletes
  their data in the app; files already saved to their save location are never touched.

Logins are remembered on each device until you sign out. Everyone can change their own password in
**Settings → Account** (other devices are signed out).

## Configuration (`.env`)

| Variable | Meaning |
| --- | --- |
| `POSTGRES_PASSWORD` | Database password. Set it before the first start. |
| `PORT` | Port to serve on (default 3000). |
| `DATA_PATH` | Where uploads, generated media and the encryption key live (default `./data`). |
| `EXPORT_ROOT` | Host folder mounted at `/exports`, for users whose save location is *Server folder*. |
| `APP_SECRET` | Optional key for encrypting stored secrets. Default: a random key generated once into `data/app.key`. |
| `ADMIN_USERNAME`, `ADMIN_PASSWORD` | Optional: create the admin on first start instead of in the browser (empty database only). |
| `PUBLIC_URL` | Optional: base URL agents download results from (e.g. `https://studio.tailnet.ts.net`). Default: the address the agent connected to. |
| `MOCK_PROVIDER=1` | Development only: adds a free "Mock" provider. |

Saving to SMB uses `smbclient` inside the container, so no host mounts or drive letters are needed.

## Using it from your phone

Open `http://<server-ip>:3000` on your network, or serve it over HTTPS to get the iPhone share sheet
("Save to Photos") and offline app loading. With [Tailscale](https://tailscale.com):

```bash
tailscale serve --bg 3000
```

Then open `https://<machine>.<tailnet>.ts.net` (reachable only from your own devices). iPhone: Safari →
Share → **Add to Home Screen**. Android: Chrome menu → **Install app**. The installed app has its own
login (sign in once). `tailscale serve reset` stops the HTTPS address.

## Connecting agents (MCP)

The studio is an MCP server at `http://<server>:3000/mcp` (Streamable HTTP), reachable over your LAN or
Tailscale. In **Settings → Agents**, create a key per agent and choose what it may do: generate, folders,
upload references, presets, save, delete, and which workspaces it can use. The key is shown once, with a
ready-to-paste Hermes config:

```yaml
mcp_servers:
  spicy-studio:
    url: "http://<server>:3000/mcp"
    headers:
      Authorization: "Bearer sst_…"
    timeout: 360
```

Other MCP clients use the same URL and header. Agents work like you do in the studio: they pick models by name
(Auto models first), list model refs, uploads and environments separately (each with a link to view it), pass
references by id (shown with a copy button in every full-screen view) or by a unique name, mention elements as `@Name`,
put results in folders (created on the fly), send an `idempotency_key` so a retry after a crash never pays twice, start several prompts in one call, find lost jobs
with `list_generations`, optionally have the prompt assistant rewrite their prompt (`enhance_prompt`), start from presets and save to your save location (metadata stripped
when that's on). `get_results` returns each file's `url` and `cleanUrl` (metadata stripped); download them with
the same `Authorization` header. Results appear in the studio live, marked "Made by <agent>". Keys only work on
the MCP endpoint and agent downloads: never on settings, provider keys or admin pages. Delete a key to cut an
agent off immediately.

## Backups and updates

Back up the database **and** `data/` (media and `data/app.key`). Without `app.key` (or your
`APP_SECRET`) the stored API keys, Higgsfield logins and SMB passwords can't be decrypted, and users
would have to enter them again.

```bash
docker compose exec -T db pg_dump -U studio -d studio -Fc > studio.dump
```

To update: `git pull && docker compose up -d --build`. Database migrations run automatically on start.

## Development

```bash
npm install
# needs Postgres: set DATABASE_URL (default postgres://studio:studio@localhost:5432/studio)
npm run dev:server        # API on :3000 (tsx watch)
npm run dev:web           # Vite on :5173, proxies /api and /media
npm test                  # server unit tests (vitest)
npm run build             # build both packages
```

Stack: Node 22, TypeScript, Fastify 5, PostgreSQL (plain SQL, versioned migrations), sharp, ffmpeg,
smbclient; React 19, Vite, Tailwind 4, TanStack Query, zustand. See [AGENTS.md](AGENTS.md) for the
architecture and conventions.

## License

[GNU General Public License v3.0](LICENSE) or later.

This project is not affiliated with SpicyAPI or Higgsfield. You need your own accounts with them, and
generations are billed by them.
