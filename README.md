# bb-plugin-cloud-sandbox

A bb plugin that runs code and commands inside an isolated
[Vercel Sandbox](https://vercel.com/docs/vercel-sandbox) microVM and captures
the output.

One core (`sandbox.ts`) serves three surfaces:

- **Cloud Sandbox page** (`app.tsx`) — paste a Node or Python snippet, run it,
  read stdout/stderr/exit code, browse recent runs.
- **`bb cloud-sandbox` CLI** (`server.ts`) — what agents use.
- **Skill** (`skills/cloud-sandbox/SKILL.md`) — tells agents when and how.

## Setup

### 1. Vercel credentials

```sh
npm i -g vercel
vercel login
cd ~/bb-plugin-cloud-sandbox
vercel link      # pick or create the Vercel project sandboxes bill to
vercel env pull  # writes .env.local, including VERCEL_OIDC_TOKEN
```

`vercel env pull` is enough for the standalone verification script below.
`VERCEL_OIDC_TOKEN` is short-lived, though, so the **plugin** authenticates
with a personal access token instead — create one at
<https://vercel.com/account/tokens>.

### 2. Verify the sandbox works, without bb

```sh
npm run verify:sandbox
```

Boots a real sandbox, runs a Node snippet in it, prints the captured output,
and exits non-zero if anything came back wrong. It reads `.env.local`, or
`VERCEL_TOKEN` + `VERCEL_TEAM_ID` + `VERCEL_PROJECT_ID` from the environment.

### 3. Install and configure the plugin

```sh
bb plugin install .
bb plugin config cloud-sandbox set vercelToken <token>
bb plugin config cloud-sandbox set teamId <team-id>
bb plugin config cloud-sandbox set projectId <project-id>
bb plugin reload cloud-sandbox
bb cloud-sandbox status
```

`teamId` and `projectId` are the `orgId` and `projectId` in the
`.vercel/project.json` that `vercel link` wrote.

## Usage

```sh
bb cloud-sandbox run 'console.log(1 + 1)'
bb cloud-sandbox run --runtime python 'print(sum(range(10)))'
bb cloud-sandbox exec bash -lc 'uname -a && node --version'
bb cloud-sandbox history --json
```

## Development

```sh
bb plugin dev        # rebuild + reload on every save
npm run typecheck
npm run build
bb plugin logs cloud-sandbox -f
```

## Notes

- Every run boots a fresh sandbox and stops it in a `finally` — a leaked
  sandbox keeps billing until its own timeout fires.
- `bb.cli` `run` executes on the bb **server**, so `bb cloud-sandbox` takes
  code inline rather than a file path, which would name a file on the
  invoking machine instead.
- Run history is capped at 25 entries with per-stream output truncated, to
  stay under the 256KB `bb.storage.kv` value cap.
