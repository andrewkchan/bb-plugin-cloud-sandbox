# bb-plugin-cloud-sandbox

A bb plugin that runs code inside an isolated
[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVM and shows the
captured output. The interface is entirely graphical.

- **Cloud Sandbox page** — paste a Node or Python snippet, run it, read
  stdout/stderr/exit code, browse recent runs.
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
| `oauthClientId` | Vercel SDK's client | Set this to your own registered Vercel OAuth client for a branded consent screen |
| `defaultRuntime` | `node` | Runtime preselected on the page |
| `sandboxTimeoutSeconds` | `300` | Sandbox and command timeout |
| `vercelSession` | — | Managed by the sign-in flow; do not edit by hand |

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
| `sandbox.ts` | Boots a sandbox, stages files, runs a command, captures output. No bb dependency. |
| `auth.ts` | Vercel OAuth device authorization (RFC 8628). No bb dependency. |
| `server.ts` | Settings, RPC, sign-in orchestration, run history. |
| `app.tsx` | The Cloud Sandbox page and the Vercel account settings section. |
| `scripts/verify-sandbox.ts` | Standalone end-to-end check. |

## Notes

- Every run boots a fresh sandbox and stops it in a `finally` — a leaked
  sandbox keeps billing until its own timeout fires.
- `auth.ts` implements the device grant directly rather than calling
  `@vercel/sandbox`'s `OAuth()`, whose client id is a module constant with no
  parameter or env override. Doing it directly keeps `oauthClientId`
  swappable.
- The access token and refresh token live in a single `secret` setting, so
  they are stored in the plugin's 0600 secrets directory rather than in
  `bb.db`. They are written through `bb.sdk.plugins.updateSettings`, because a
  settings handle is read-only by design.
- `inferScope` is called with `cwd` pinned to a temp directory. It otherwise
  reads `.vercel/project.json` relative to `process.cwd()` — wherever the bb
  server was launched — and could silently adopt an unrelated linked project.
- Run history is capped at 25 entries with per-stream output truncated, to
  stay under the 256KB `bb.storage.kv` value cap.
