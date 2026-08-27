# bb-plugin-cloud-sandbox

A bb plugin that turns [Vercel Sandboxes](https://vercel.com/docs/vercel-sandbox)
into bb machines. Each "cloud machine" is a sandbox that installs bb and
enrols itself over bb connect, so it appears alongside your local machines and
can run threads. The interface is entirely graphical.

- **Cloud Machines page** — list machines with live status, create one, stop
  one, refresh, and a collapsible debug log.
- **Settings → Vercel account** — one **Sign in with Vercel** button.

## Setup

```sh
bb plugin install .
```

Then open the plugin's settings page and click **Sign in with Vercel**. That
is the whole setup: approve the device code in the browser tab that opens, and
the plugin resolves your Vercel team and creates a sandbox project if you do
not already have one.

There is no CLI to install, no access token to copy, and no team or project id
to look up. The session refreshes itself, so the sign-in is one-time.

## Configuration

Everything is optional and lives in the plugin's settings page.

| Setting | Default | Purpose |
| --- | --- | --- |
| `machineTimeoutSeconds` | `2700` | How long a machine lives before Vercel terminates it |
| `machineVcpus` | `2` | vCPUs per machine (2 GB memory each) |
| `vercelSession` | — | Managed by the sign-in flow; do not edit by hand |

Vercel caps sandbox lifetime at **45 minutes on Hobby** and 24 hours on
Pro/Enterprise, with exceeding it failing sandbox creation outright
(`timeout should be <= 45m`). The default is the Hobby ceiling, which every
plan accepts; raise it if your team is on Pro.

**A cloud machine is therefore not long-lived.** Vercel terminates it at that
limit whatever it is doing, and the machine goes `Inactive`. This is a
property of the platform, not something the plugin can extend.

## Verifying the sandbox without bb

`scripts/verify-sandbox.ts` boots a real sandbox, runs a Node snippet, prints
the captured output, and exits non-zero if anything came back wrong. It is
independent of the plugin and authenticates from the environment:

```sh
vercel link && vercel env pull   # writes .env.local with VERCEL_OIDC_TOKEN
npm run verify:sandbox
```

It also accepts `VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID`.

## Development

```sh
bb plugin dev        # rebuild + reload on every save
npm run typecheck
npm run build
bb plugin logs cloud-sandbox -f
```

## Layout

| File | Role |
| --- | --- |
| `sandbox.ts` | Boots a sandbox, stages files, runs one command, captures output. No bb dependency. |
| `machines.ts` | Cloud machine lifecycle: create, enrol, list, stop. No bb dependency. |
| `auth.ts` | Vercel OAuth device authorization (RFC 8628). No bb dependency. |
| `server.ts` | Settings, RPC, sign-in orchestration, machine state, debug log. |
| `app.tsx` | The Cloud Machines page and the Vercel account settings section. |
| `scripts/verify-sandbox.ts` | Standalone end-to-end sandbox check. |

## How enrolment works

A machine runs bb's own installer, the same one behind **Settings → Machines →
Add a machine**. Three things about doing that inside a sandbox are not
obvious, and each was found by watching a real enrolment fail:

1. **`build-essential`** — the Vercel universal image ships Node but no C
   toolchain, and bb-app's `node-pty` dependency is compiled from source.
   Without it the install dies at `not found: make`.
2. **`BB_INSTALL_SKIP_SERVICE=1`** — the installer's final step registers a
   systemd user service, and containers have no systemd (`systemctl: not
   found`). This flag leaves the already-joined daemon running as a plain
   `nohup`'d process, which is what a disposable VM wants.
3. **The bb connect tunnel URL** — bb listens on loopback by default, and a
   sandbox on the public internet cannot reach `127.0.0.1`. The enrolment
   uses the public `serverUrl` that bb connect mints with the machine code, so
   **the connect plugin must be enabled and paired.**

Enrolment takes roughly a minute, most of it installing the toolchain and
building native modules, so a new machine sits at `Connecting` for a while.

## Notes

- Every run boots a fresh sandbox and stops it in a `finally` — a leaked
  sandbox keeps billing until its own timeout fires.
- `auth.ts` implements the device grant directly rather than calling
  `@vercel/sandbox`'s `OAuth()`, whose client id is a module constant with no
  parameter or env override. Every function here takes an optional client id,
  so pointing the plugin at your own registered Vercel integration means
  changing `DEFAULT_CLIENT_ID` in `auth.ts`.
- The access token and refresh token live in a single `secret` setting, so
  they are stored in the plugin's 0600 secrets directory rather than in
  `bb.db`. They are written through `bb.sdk.plugins.updateSettings`, because a
  settings handle is read-only by design.
- `inferScope` is called with `cwd` pinned to a temp directory. It otherwise
  reads `.vercel/project.json` relative to `process.cwd()` — wherever the bb
  server was launched — and could silently adopt an unrelated linked project.
- The debug log is capped at 200 events to stay under the 256KB
  `bb.storage.kv` value cap. Nothing reads it to make decisions; it exists to
  answer "what did this plugin ask Vercel and bb to do, and when".
- Status is derived, not stored: Vercel is the authority on whether the
  sandbox is up, and bb's host registry is the authority on whether the
  machine actually connected. A sandbox that is `running` but whose host is
  not `connected` is still `Connecting`.
- There is no push event for a machine ending, so a disconnect is recorded
  when a refresh first observes it.
- The page polls every 45s while it is open, and the interval is cleared on
  unmount. Overlapping refreshes are suppressed so a slow list cannot stack
  up behind the timer.
