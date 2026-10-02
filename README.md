# Spicy Studio

A self-hosted, multi-user studio for AI image and video generation, in the spirit of
Higgsfield's web app: workspaces per character or project, reusable references and
`@elements`, one-click recreate, folders, batch generation, live cost estimates, and
one-click saving to a NAS. Dark mode, works on desktop and phones (installable as a PWA).

Providers:

- **[SpicyAPI](https://spicyapi.ai)**: 150+ image and video models with an API key.
- **[Higgsfield](https://higgsfield.ai)**: your Higgsfield account through its MCP server
  (OAuth sign-in, paid with your Higgsfield credits). Gives access to models such as
  Seedream 4.5, Kling 3.0 and Seedance 2.0.

New providers plug in behind one interface (see [AGENTS.md](AGENTS.md)).

## Features

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

- **Providers → SpicyAPI**: paste your API key.
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
