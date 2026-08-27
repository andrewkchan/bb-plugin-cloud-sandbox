# bb-plugin-cloud-sandbox

A bb plugin that turns [Vercel Sandboxes](https://vercel.com/docs/vercel-sandbox)
into bb machines. Each "cloud machine" is a sandbox that installs bb and
enrols itself over bb connect, so it appears alongside your local machines and
can run threads. The interface is entirely graphical.

- **Cloud Machines page** — a table of machines with status, created and
  last-used times, sortable by name or either date and filterable by status,
  plus create/stop/remove, manual refresh, and a collapsible debug log.
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
| `machines.ts` | Cloud machine lifecycle: create, enrol, list, stop, delete. No bb dependency. |
| `auth.ts` | Vercel OAuth device authorization (RFC 8628). No bb dependency. |
| `server.ts` | Settings, RPC, sign-in orchestration, machine state, debug log. |
| `app.tsx` | The Cloud Machines page and the Vercel account settings section. |

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
- A disconnect keeps both the local record and the bb host. The daemon's
  durable `hostId`/`hostKey` live in the sandbox filesystem
  (`~/.bb-machines/<server>/auth.json`), so deleting the bb host would
  invalidate them. A `disconnected` host is the correct state for a machine
  that is off but could come back — the same state bb shows for a sleeping
  laptop. Only an explicit **Remove** deletes the host and the record.
- **Stop** and **Remove** are different operations. Stop ends the sandbox but
  keeps the record and the bb host, so the machine stays listed as `Inactive`
  and could be woken later. Remove is not reversible: it deletes the Vercel
  sandbox and every snapshot belonging to it, deletes the bb host, drops the
  local record, and hides the row. It is styled destructively for that reason.
- Deleting snapshots matters more than it looks. Stopping a sandbox can
  produce one even when `persistent` was never requested, and they are not
  small — a single machine left a 937 MB snapshot behind during development.
  Remove deletes them; Stop deliberately does not, because a snapshot is what
  a future wake would restore from.
- Removal order is deliberate: stop, then delete snapshots, then delete the
  sandbox. `delete()` leaves the instance inert, so listing snapshots
  afterwards would throw. A snapshot that will not delete is reported in the
  debug log rather than blocking the rest of the removal.
- Removing is the *only* way a row leaves the list. The list is derived from
  `Sandbox.list()`, and Vercel keeps returning stopped sandboxes indefinitely,
  so removed names are held in a bounded `dismissed` set in `bb.storage.kv`
  and filtered out.
- A row is titled by its **sandbox name**, with the bb host id as a subtitle.
  The sandbox name is the one identifier this plugin owns; bb's host *name*
  is the container's hostname, which a resumed sandbox may not keep.
- "Last used" is bb's `lastSeenAt` for the machine's host — when bb last heard
  from the daemon — falling back to Vercel's sandbox `updatedAt` for a machine
  that never connected. A machine with no last-used time sorts last in either
  direction rather than jumping between ends of the table.
- The table is capped at 26rem and scrolls, with a sticky header, so a long
  list cannot push the debug log off the page.
- The page polls every 45s while it is open, and the interval is cleared on
  unmount. Overlapping refreshes are suppressed so a slow list cannot stack
  up behind the timer.
