# bb-plugin-cloud-sandbox

**Cloud Machines** — spin up and manage cloud machines backed by
[Vercel Sandboxes](https://vercel.com/docs/vercel-sandbox).

Each cloud machine is a sandbox that installs bb and enrols itself over bb
connect, so it appears alongside your local machines and can run threads. There
is currently no CLI interface.

- **Cloud Machines page** — a table of machines with status, created and
  last-used times, sortable by name or either date and filterable by status.
  Each row shows the image it was created from and has a menu to wake, stop or
  delete it.
- **Settings** — two tabs: **Templates** (what a machine is made of) and
  **Authentication** (the Vercel account).

![The Cloud Machines page, listing machines with their status, template, and session uptime](docs/cloud-machines.png)

Create a machine from the template named on the button, or pick another from
the chevron.

## Setup

```sh
bb plugin install .
```

Then open the plugin's settings page and click **Sign in with Vercel**.

## Configuration

Everything is optional and lives in the plugin's settings page.

| Setting | Default | Purpose |
| --- | --- | --- |
| `machineTimeoutSeconds` | `2700` | How long a machine lives before Vercel terminates it |
| `machineVcpus` | `2` | vCPUs per machine (2 GB memory each) |
| `templateSecrets` | — | Managed by each template's environment editor; do not edit by hand |
| `vercelSession` | — | Managed by the sign-in flow; do not edit by hand |

Vercel caps sandbox lifetime at **45 minutes on Hobby** and 24 hours on
Pro/Enterprise.

**A cloud machine is therefore not long-lived.** Vercel terminates it at that
limit whatever it is doing, and the machine goes `Inactive`.

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
| `machines.ts` | Cloud machine lifecycle: create, enrol, list, stop, wake, delete. No bb dependency. |
| `scripts/*.sh` | What a machine runs on itself: enrolment, wake, and the daemon supervisor that stands in for the service manager a container has none of. |
| `templates.ts` | Template presets, the Dockerfile, the image build, and registry cleanup. No bb dependency. |
| `agents.ts` | Agent providers and the credentials each one reads. No bb dependency. |
| `auth.ts` | Vercel OAuth device authorization (RFC 8628). No bb dependency. |
| `server.ts` | Settings, RPC, sign-in orchestration, template and machine state, debug log. |
| `app.tsx` | The Cloud Machines page and the settings tabs. |

## Environment and credentials

Each template holds its own environment: the credentials listed by agent
provider (currently Claude Code and pi.dev), plus any other variable you add.
All of it is injected into a machine's environment **when the machine is
created**, so nothing reaches an image layer, and changing a value takes
effect on the next machine rather than the next build. Values are write-only:
the plugin reports which keys are set and never returns one.

Because the build never sees them, custom commands cannot use these
variables — a build step that needs a credential is not supported.

Earlier versions baked a template's variables into its image instead. Nothing
carries those over: set them again here, and rebuild to clear the values still
sitting in the old image's layers.

## Templates

![The Templates tab, with one template building and one ready to use](docs/templates.png)

A template is what a cloud machine is made of: an image, plus the environment
its machines are given.

**Create template** starts from a preset — Blank, Claude Code, or
[pi.dev](https://pi.dev). A preset only seeds a new template's name and
commands; it is ordinary editable configuration afterwards, not a link that
keeps updating. Each template has a name, a block of custom commands, and its
environment; building publishes its image to the container registry and the
template becomes `Ready`.

Every image starts from `docker.io/library/ubuntu:26.04` and installs bb's
prerequisites first: Node (the host daemon needs 22.19+ and the stock base
ships none) and a C toolchain (bb-app's `node-pty` is a native add-on built
from source at enrolment).

Nothing from a template's environment enters the image: an image is a shared
artifact anyone able to pull it can read, so credentials are injected when a
machine is created instead.

Templates and their build logs live in the plugin's SQLite database rather
than `bb.storage.kv`, because a build log routinely exceeds the 256KB kv value
cap.

**Creating a machine** uses the template most recently used, changeable from
the chevron beside the button; the dropdown also offers "No template" for
Vercel's default managed image.

Deleting a template removes it, its build history and its environment from bb
**and deletes its image from the container registry**.

## Building custom images

Vercel Sandbox boots from OCI images in
[Vercel Container Registry](https://vercel.com/docs/sandbox/concepts/images).
Images are built **inside a throwaway sandbox**. 

The registry is `vcr.vercel.com`, images live at
`<teamSlug>/<projectId>/<repo>:<tag>`.