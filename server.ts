// bb-plugin-cloud-sandbox — cloud machines backed by Vercel Sandboxes.
//
// A "cloud machine" is a Vercel Sandbox that has enrolled itself as a bb
// machine, so it shows up alongside local machines and can run threads. The
// interface is entirely graphical: a Cloud Machines page and a settings
// section for connecting a Vercel account over OAuth.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { inferScope } from "@vercel/sandbox/dist/auth/index.js";
import {
  pollForSession,
  refreshSession,
  revokeToken,
  startDeviceAuthorization,
  type AuthSession,
  type DeviceAuthorization,
} from "./auth.js";
import {
  createMachine,
  destroyMachine,
  fetchSessionStarts,
  listMachines,
  stopMachine,
  wakeMachine,
  type EnrollmentDetails,
  type SandboxCredentials,
} from "./machines.js";

/** Debug events kept for troubleshooting. Bounded to stay under the kv cap. */
const MAX_EVENTS = 200;
const MACHINES_CHANGED = "machines-changed";
const AUTH_CHANGED = "auth-changed";
const REFRESH_SKEW_MS = 60_000;

const storedSessionSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string().nullable(),
  expiresAt: z.number(),
  teamId: z.string(),
  projectId: z.string(),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
});
type StoredSession = z.infer<typeof storedSessionSchema>;

/** What the Agents tab shows. The token value itself is never sent. */
const agentsStatusSchema = z.object({
  claudeCodeTokenSet: z.boolean(),
});

const authStatusSchema = z.object({
  state: z.enum(["signed-out", "pending", "signed-in"]),
  verificationUriComplete: z.string().nullable(),
  userCode: z.string().nullable(),
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
  error: z.string().nullable(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

/**
 * A debug event. This is the plugin's record of what it asked Vercel and bb
 * to do and when — it is not user-facing product state, and nothing reads it
 * to make decisions.
 */
const eventSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum([
    "create.requested",
    "create.sandbox-ready",
    "create.enrolled",
    "create.failed",
    "machine.disconnected",
    "machine.stopped",
    "machine.deleted",
    "machine.woken",
    "wake.requested",
    "wake.failed",
    "delete.requested",
  ]),
  /** Sandbox name, once one exists. */
  machine: z.string().nullable(),
  detail: z.string(),
});
export type DebugEvent = z.infer<typeof eventSchema>;

/** Local record of a machine this plugin created. */
const machineRecordSchema = z.object({
  /** Sandbox name; the stable key across Vercel and this plugin. */
  name: z.string(),
  /** bb host id this sandbox enrolled as. */
  hostId: z.string(),
  createdAt: z.number(),
  /** Epoch ms the machine was first observed to be no longer running. */
  disconnectedAt: z.number().nullable(),
});
type MachineRecord = z.infer<typeof machineRecordSchema>;

const machineViewSchema = z.object({
  name: z.string(),
  hostId: z.string().nullable(),
  /** bb's name for the machine, once it has connected. */
  hostName: z.string().nullable(),
  state: z.enum(["connecting", "running", "inactive", "error"]),
  /** Human-readable status line for the list. */
  status: z.string(),
  /** Milliseconds the sandbox has been up, when running. */
  uptimeMs: z.number().nullable(),
  createdAt: z.number(),
  /**
   * When the VM currently backing this machine started. Null when it is not
   * running. Distinct from createdAt, which is when the sandbox first existed.
   */
  sessionStartedAt: z.number().nullable(),
  /**
   * When bb last heard from the machine, falling back to when Vercel last
   * changed the sandbox's state for a machine that never connected.
   */
  lastUsedAt: z.number().nullable(),
  /** True while this machine is being woken. */
  waking: z.boolean(),
  error: z.string().nullable(),
});
export type MachineView = z.infer<typeof machineViewSchema>;

export const rpcContract = defineRpcContract({
  auth_status: { input: z.null(), output: authStatusSchema },
  agents_status: { input: z.null(), output: agentsStatusSchema },
  agents_set_claude_token: {
    input: z.object({ token: z.string() }),
    output: agentsStatusSchema,
  },
  auth_start: { input: z.null(), output: authStatusSchema },
  auth_cancel: { input: z.null(), output: authStatusSchema },
  auth_sign_out: { input: z.null(), output: authStatusSchema },
  machines_list: {
    input: z.null(),
    output: z.object({
      machines: z.array(machineViewSchema),
      signedIn: z.boolean(),
      /** True while a create is in flight, so the page can show a spinner. */
      creating: z.boolean(),
      /** Deep link to this project's sandboxes on vercel.com, when derivable. */
      vercelUrl: z.string().nullable(),
    }),
  },
  machines_create: { input: z.null(), output: z.object({ started: z.boolean() }) },
  /** Resume a stopped machine and bring its bb daemon back. */
  machines_wake: {
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ started: z.boolean() }),
  },
  /** End the sandbox but keep the machine listed, so it can be woken later. */
  machines_stop: {
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ stopped: z.boolean() }),
  },
  /** Forget the machine entirely and hide its row. */
  machines_remove: {
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ removed: z.boolean() }),
  },
  events_list: {
    input: z.null(),
    output: z.object({ events: z.array(eventSchema) }),
  },
  events_clear: { input: z.null(), output: z.object({ cleared: z.number() }) },
});

/** "12h 34m", "7m", "<1m" — always reads correctly after "Running for". */
function formatUptime(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  if (hours === 0) return `${remaining}m`;
  return `${hours}h ${remaining}m`;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    vercelSession: {
      type: "string",
      label: "Vercel session (managed by Sign in with Vercel)",
      secret: true,
    },
    // Vercel caps sandbox lifetime at 45 minutes on Hobby and 24 hours on
    // Pro/Enterprise; exceeding it fails sandbox creation outright. Default
    // to the Hobby ceiling, which every plan accepts.
    machineTimeoutSeconds: {
      type: "string",
      label: "Machine lifetime (seconds; max 2700 on Hobby, 86400 on Pro)",
      default: "2700",
    },
    // Claude Code accepts a long-lived OAuth token from `claude setup-token`.
    // It is injected into the machine's environment at creation, not baked
    // into an image, so it never lands in a shared image layer.
    claudeCodeOauthToken: {
      type: "string",
      label: "Claude Code OAuth token",
      secret: true,
    },
    machineVcpus: {
      type: "select",
      label: "vCPUs per machine (2 GB memory each)",
      options: ["1", "2", "4", "8"],
      default: "2",
    },
  });

  let pending: {
    authorization: DeviceAuthorization;
    controller: AbortController;
  } | null = null;
  let lastAuthError: string | null = null;
  let refreshInFlight: Promise<StoredSession> | null = null;
  /** In-flight machine creations, by a temporary id until the sandbox exists. */
  const creating = new Set<string>();
  /** Sandbox names currently being woken. */
  const waking = new Set<string>();

  // ---------------------------------------------------------------- events

  async function readEvents(): Promise<DebugEvent[]> {
    return (await bb.storage.kv.get<DebugEvent[]>("events")) ?? [];
  }
  async function record(
    kind: DebugEvent["kind"],
    machine: string | null,
    detail: string,
  ): Promise<void> {
    const event: DebugEvent = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      kind,
      machine,
      detail: detail.slice(0, 2000),
    };
    const events = [event, ...(await readEvents())].slice(0, MAX_EVENTS);
    await bb.storage.kv.set("events", events);
    bb.log.info(`${kind}${machine === null ? "" : ` ${machine}`}: ${detail}`);
  }

  // ------------------------------------------------------------------ auth

  async function readStoredSession(): Promise<StoredSession | null> {
    const { vercelSession } = await settings.get();
    if (vercelSession === undefined || vercelSession.trim() === "") return null;
    const parsed = storedSessionSchema.safeParse(
      JSON.parse(vercelSession) as unknown,
    );
    return parsed.success ? parsed.data : null;
  }

  async function writeStoredSession(session: StoredSession | null) {
    await bb.sdk.plugins.updateSettings({
      pluginId: bb.pluginId,
      values: {
        vercelSession: session === null ? "" : JSON.stringify(session),
      },
    });
  }

  async function describeAuth(): Promise<AuthStatus> {
    const stored = await readStoredSession();
    if (stored !== null) {
      return {
        state: "signed-in",
        verificationUriComplete: null,
        userCode: null,
        teamSlug: stored.teamSlug,
        projectSlug: stored.projectSlug,
        error: null,
      };
    }
    if (pending !== null) {
      return {
        state: "pending",
        verificationUriComplete: pending.authorization.verificationUriComplete,
        userCode: pending.authorization.userCode,
        teamSlug: null,
        projectSlug: null,
        error: lastAuthError,
      };
    }
    return {
      state: "signed-out",
      verificationUriComplete: null,
      userCode: null,
      teamSlug: null,
      projectSlug: null,
      error: lastAuthError,
    };
  }

  /**
   * `cwd` is pinned to a temp directory on purpose: inferScope otherwise reads
   * `.vercel/project.json` relative to `process.cwd()`, which is wherever the
   * bb server happened to be launched.
   */
  async function resolveScope(session: AuthSession): Promise<StoredSession> {
    const scope = await inferScope({
      token: session.accessToken,
      cwd: tmpdir(),
    });
    return {
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      expiresAt: session.expiresAt,
      teamId: scope.teamId,
      projectId: scope.projectId,
      teamSlug: scope.teamSlug ?? null,
      projectSlug: scope.projectSlug ?? null,
    };
  }

  async function ensureFreshSession(): Promise<StoredSession | null> {
    const stored = await readStoredSession();
    if (stored === null) return null;
    if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) return stored;
    if (stored.refreshToken === null) return stored;

    refreshInFlight ??= (async () => {
      const refreshed = await refreshSession(stored.refreshToken!);
      const next: StoredSession = { ...stored, ...refreshed };
      await writeStoredSession(next);
      return next;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function requireCredentials(): Promise<SandboxCredentials> {
    const session = await ensureFreshSession();
    if (session === null) {
      throw new Error(
        "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
      );
    }
    return {
      token: session.accessToken,
      teamId: session.teamId,
      projectId: session.projectId,
    };
  }

  function beginSignIn(authorization: DeviceAuthorization) {
    const controller = new AbortController();
    pending = { authorization, controller };
    lastAuthError = null;

    void (async () => {
      try {
        const session = await pollForSession(
          authorization,
          undefined,
          controller.signal,
        );
        const stored = await resolveScope(session);
        pending = null;
        // Written last: persisting while the plugin is in needs-configuration
        // makes bb retry the load, which replaces this generation.
        await writeStoredSession(stored);
      } catch (error) {
        pending = null;
        lastAuthError = error instanceof Error ? error.message : String(error);
        bb.log.warn(`sign-in failed: ${lastAuthError}`);
      }
      try {
        bb.realtime.publish(AUTH_CHANGED, {});
      } catch {
        // Generation replaced by the settings write above.
      }
    })();
  }

  async function startSignIn(): Promise<AuthStatus> {
    if (pending !== null) return describeAuth();
    if ((await readStoredSession()) !== null) return describeAuth();
    const authorization = await startDeviceAuthorization();
    beginSignIn(authorization);
    return describeAuth();
  }

  async function signOut(): Promise<AuthStatus> {
    pending?.controller.abort();
    pending = null;
    lastAuthError = null;
    const stored = await readStoredSession();
    if (stored !== null) {
      await revokeToken(stored.accessToken).catch(() => undefined);
      await writeStoredSession(null);
    }
    return describeAuth();
  }

  // -------------------------------------------------------------- machines

  async function readDismissed(): Promise<string[]> {
    return (await bb.storage.kv.get<string[]>("dismissed")) ?? [];
  }
  async function dismiss(name: string): Promise<void> {
    const dismissed = await readDismissed();
    if (dismissed.includes(name)) return;
    // Bounded: Vercel never stops listing a stopped sandbox, but the set only
    // needs to cover what it still returns.
    await bb.storage.kv.set("dismissed", [name, ...dismissed].slice(0, 200));
  }

  /**
   * Deep link to the project's sandboxes on vercel.com.
   *
   * inferScope returns a slug-shaped projectId for the default project
   * ("vercel-sandbox-default-project"), which is what the dashboard path
   * wants; an explicitly linked project supplies a real projectSlug instead.
   * Without a team slug there is no path to build, so this returns null rather
   * than guessing.
   */
  function buildVercelUrl(session: StoredSession): string | null {
    if (session.teamSlug === null || session.teamSlug === "") return null;
    const project = session.projectSlug ?? session.projectId;
    if (project === "") return null;
    return `https://vercel.com/${encodeURIComponent(session.teamSlug)}/${encodeURIComponent(project)}/sandboxes`;
  }

  async function readRecords(): Promise<MachineRecord[]> {
    return (await bb.storage.kv.get<MachineRecord[]>("machines")) ?? [];
  }
  async function writeRecords(records: MachineRecord[]): Promise<void> {
    await bb.storage.kv.set("machines", records);
    bb.realtime.publish(MACHINES_CHANGED, { count: records.length });
  }

  /**
   * Ask bb for a join code and bb connect for a machine code.
   *
   * The connect machine code is what makes this work at all: it carries the
   * publicly reachable tunnel URL. bb listens on loopback by default, and a
   * sandbox on the public internet cannot dial 127.0.0.1.
   */
  async function mintEnrollment(): Promise<EnrollmentDetails> {
    const join = await bb.sdk.hosts.createJoinCode();
    const machine = await bb.sdk.plugins.callRpc({
      pluginId: "connect",
      method: "createMachineCode",
      input: null,
      outputSchema: z.object({
        code: z.string(),
        expiresAt: z.number(),
        serverUrl: z.string(),
      }),
    });
    return {
      joinCode: join.joinCode,
      hostId: join.hostId,
      serverUrl: machine.serverUrl,
      machineCode: machine.code,
    };
  }

  /** Derive the list the page renders, from Vercel plus bb's host registry. */
  async function describeMachines(): Promise<{
    machines: MachineView[];
    signedIn: boolean;
    creating: boolean;
    vercelUrl: string | null;
  }> {
    const session = await ensureFreshSession();
    if (session === null) {
      return {
        machines: [],
        signedIn: false,
        creating: creating.size > 0,
        vercelUrl: null,
      };
    }
    const credentials: SandboxCredentials = {
      token: session.accessToken,
      teamId: session.teamId,
      projectId: session.projectId,
    };

    const [allSandboxes, records, hosts, dismissed] = await Promise.all([
      listMachines(credentials),
      readRecords(),
      bb.sdk.hosts.list(),
      readDismissed(),
    ]);
    // Vercel keeps listing stopped sandboxes forever, so a removed machine
    // only disappears because this filter hides it.
    const dismissedNames = new Set(dismissed);
    const sandboxes = allSandboxes.filter(
      (sandbox) => !dismissedNames.has(sandbox.name),
    );
    const recordByName = new Map(records.map((r) => [r.name, r]));
    const hostById = new Map(hosts.map((h) => [h.id, h]));
    // Only machines that are up have a session worth asking about, which also
    // keeps this to one extra request per running machine rather than per row.
    const sessionStarts = await fetchSessionStarts(
      credentials,
      sandboxes.filter(
        (sandbox) => sandbox.status === "running" || sandbox.status === "pending",
      ),
    );

    const views: MachineView[] = sandboxes.map((sandbox) => {
      const record = recordByName.get(sandbox.name) ?? null;
      const host = record === null ? null : (hostById.get(record.hostId) ?? null);
      const sessionStartedAt = sessionStarts.get(sandbox.name) ?? null;
      // Uptime is measured from the current session, not from when the sandbox
      // first existed: waking boots a new VM, so createdAt would count the time
      // the machine spent stopped.
      const uptimeMs =
        sessionStartedAt === null ? null : Date.now() - sessionStartedAt;
      // bb's view of when the machine was last alive is more meaningful than
      // Vercel's, but only exists once the daemon has connected at least once.
      const lastUsedAt = host?.lastSeenAt ?? sandbox.updatedAt;

      if (sandbox.status === "failed" || sandbox.status === "aborted") {
        return {
          name: sandbox.name,
          hostId: record?.hostId ?? null,
          hostName: host?.name ?? null,
          state: "error" as const,
          status: `Error (${sandbox.status})`,
          uptimeMs: null,
          createdAt: sandbox.createdAt,
          sessionStartedAt,
          lastUsedAt,
          waking: waking.has(sandbox.name),
          error: `Sandbox ${sandbox.status}`,
        };
      }
      if (sandbox.status !== "running" && sandbox.status !== "pending") {
        return {
          name: sandbox.name,
          hostId: record?.hostId ?? null,
          hostName: host?.name ?? null,
          state: "inactive" as const,
          status: "Inactive",
          uptimeMs: null,
          createdAt: sandbox.createdAt,
          sessionStartedAt,
          lastUsedAt,
          waking: waking.has(sandbox.name),
          error: null,
        };
      }
      // The sandbox is up. It is only a usable machine once its daemon has
      // dialled home, so bb's host registry is the authority on "running".
      if (host?.status === "connected") {
        return {
          name: sandbox.name,
          hostId: record?.hostId ?? null,
          hostName: host.name,
          state: "running" as const,
          status:
            uptimeMs === null
              ? "Running"
              : `Running for ${formatUptime(uptimeMs)}`,
          uptimeMs,
          createdAt: sandbox.createdAt,
          sessionStartedAt,
          lastUsedAt,
          waking: waking.has(sandbox.name),
          error: null,
        };
      }
      return {
        name: sandbox.name,
        hostId: record?.hostId ?? null,
        hostName: host?.name ?? null,
        state: "connecting" as const,
        status: "Connecting",
        uptimeMs: null,
        createdAt: sandbox.createdAt,
        sessionStartedAt,
        lastUsedAt,
        waking: waking.has(sandbox.name),
        error: null,
      };
    });

    // Detect machines that dropped off since the last look. There is no push
    // event for a sandbox ending, so a poll-time transition is the only signal.
    for (const view of views) {
      if (view.state !== "inactive" && view.state !== "error") continue;
      if (!recordByName.has(view.name)) continue;
      await noteDisconnect(view);
    }

    return {
      machines: views,
      signedIn: true,
      creating: creating.size > 0,
      vercelUrl: buildVercelUrl(session),
    };
  }

  /**
   * Note a machine's first observed disconnect. The record is deliberately
   * KEPT: it is how the row holds on to its bb host id, how Remove finds the
   * host to delete, and — once waking a machine exists — how a resumed
   * sandbox is recognised as the same machine.
   *
   * The bb host is deliberately NOT deleted either. The daemon's durable
   * hostId/hostKey live in the sandbox filesystem, so removing the host here
   * would invalidate them; a `disconnected` host is the correct state for a
   * machine that is off but can come back, exactly like a sleeping laptop.
   */
  async function noteDisconnect(view: MachineView): Promise<void> {
    const records = await readRecords();
    const target = records.find((r) => r.name === view.name) ?? null;
    if (target === null || target.disconnectedAt !== null) return;
    await record(
      "machine.disconnected",
      view.name,
      `Machine is no longer running (${view.status}).`,
    );
    await writeRecords(
      records.map((r) =>
        r.name === view.name ? { ...r, disconnectedAt: Date.now() } : r,
      ),
    );
  }

  /**
   * Agent credentials handed to a machine at creation.
   *
   * These are deliberately environment variables on the sandbox rather than
   * anything baked into an image: an image is a shared artifact, and a
   * long-lived token must not end up in one of its layers.
   */
  async function agentEnv(): Promise<Record<string, string>> {
    const { claudeCodeOauthToken } = await settings.get();
    const token = (claudeCodeOauthToken ?? "").trim();
    return token === "" ? {} : { CLAUDE_CODE_OAUTH_TOKEN: token };
  }

  async function startCreate(): Promise<boolean> {
    const credentials = await requireCredentials();
    const values = await settings.get();
    const seconds = Number.parseInt(values.machineTimeoutSeconds, 10);
    const timeoutMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2_700_000;
    const vcpus = Number.parseInt(values.machineVcpus, 10);

    const ticket = randomUUID().slice(0, 8);
    creating.add(ticket);
    bb.realtime.publish(MACHINES_CHANGED, {});

    void (async () => {
      try {
        await record("create.requested", null, "Creating a cloud machine.");
        const enrollment = await mintEnrollment();
        const result = await createMachine({
          credentials,
          enrollment,
          env: await agentEnv(),
          timeoutMs,
          vcpus: Number.isFinite(vcpus) ? vcpus : 2,
          onCreated: async (name) => {
            // The list can show a "Connecting" row from here, well before the
            // multi-minute enrollment finishes.
            await writeRecords([
              {
                name,
                hostId: enrollment.hostId,
                createdAt: Date.now(),
                disconnectedAt: null,
              },
              ...(await readRecords()),
            ]);
            await record("create.sandbox-ready", name, "Sandbox created.");
          },
        });
        await record(
          "create.enrolled",
          result.name,
          "Machine enrolled and connected to bb.",
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        await record("create.failed", null, message);
      } finally {
        creating.delete(ticket);
        bb.realtime.publish(MACHINES_CHANGED, {});
      }
    })();

    return true;
  }

  /**
   * Resume a stopped machine in the background. The page shows the row as
   * waking meanwhile; the machine returns to Running once its daemon has
   * reconnected, which the ordinary status derivation picks up.
   */
  async function startWake(name: string): Promise<boolean> {
    if (waking.has(name)) return false;
    const credentials = await requireCredentials();
    waking.add(name);
    bb.realtime.publish(MACHINES_CHANGED, {});

    void (async () => {
      try {
        await record("wake.requested", name, "Waking machine.");
        const detail = await wakeMachine(credentials, name);
        // A resumed machine is live again, so clear the disconnect marker.
        const records = await readRecords();
        await writeRecords(
          records.map((r) =>
            r.name === name ? { ...r, disconnectedAt: null } : r,
          ),
        );
        await record("machine.woken", name, detail);
      } catch (error) {
        await record(
          "wake.failed",
          name,
          error instanceof Error ? error.message : String(error),
        );
      } finally {
        waking.delete(name);
        bb.realtime.publish(MACHINES_CHANGED, {});
      }
    })();
    return true;
  }

  /**
   * End the sandbox, but keep the record and the bb host so the machine stays
   * listed as Inactive and can be woken later.
   */
  async function stopMachineByName(name: string): Promise<boolean> {
    const credentials = await requireCredentials();
    await record("delete.requested", name, "Stopping machine.");
    try {
      await stopMachine(credentials, name);
    } catch (error) {
      // Already stopped is the common case and not a failure.
      bb.log.info(
        `stop ${name}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const records = await readRecords();
    await writeRecords(
      records.map((r) =>
        r.name === name && r.disconnectedAt === null
          ? { ...r, disconnectedAt: Date.now() }
          : r,
      ),
    );
    await record("machine.stopped", name, "Machine stopped.");
    return true;
  }

  /**
   * Delete the sandbox and its snapshots, drop its bb host
   * registration, drop the local record, and hide the row. Nothing here is
   * reversible.
   */
  async function removeMachineByName(name: string): Promise<boolean> {
    const credentials = await requireCredentials();
    await record("delete.requested", name, "Removing machine.");
    try {
      const { snapshotsDeleted, snapshotFailures } = await destroyMachine(
        credentials,
        name,
      );
      await record(
        "machine.deleted",
        name,
        snapshotFailures.length === 0
          ? `Sandbox deleted with ${snapshotsDeleted} snapshot(s).`
          : `Sandbox deleted with ${snapshotsDeleted} snapshot(s); ${snapshotFailures.length} snapshot(s) could not be deleted: ${snapshotFailures.join("; ")}`,
      );
    } catch (error) {
      // The bb-side cleanup below still runs: a sandbox that cannot be deleted
      // must not strand the machine in the list forever.
      await record(
        "machine.deleted",
        name,
        `Could not delete the sandbox: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const records = await readRecords();
    const target = records.find((r) => r.name === name) ?? null;
    if (target !== null) {
      await bb.sdk.hosts
        .delete({ hostId: target.hostId })
        .catch(() => undefined);
      await writeRecords(records.filter((r) => r.name !== name));
    }
    await dismiss(name);
    bb.realtime.publish(MACHINES_CHANGED, {});
    return true;
  }

  if ((await readStoredSession()) === null) {
    bb.status.needsConfiguration(
      "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
    );
  }

  bb.rpc.register(rpcContract, {
    auth_status: () => describeAuth(),
    agents_status: async () => {
      const { claudeCodeOauthToken } = await settings.get();
      return { claudeCodeTokenSet: (claudeCodeOauthToken ?? "").trim() !== "" };
    },
    agents_set_claude_token: async ({ token }) => {
      // Written through the settings route so it lands in the plugin's 0600
      // secrets directory rather than bb.db. An empty string clears it.
      await bb.sdk.plugins.updateSettings({
        pluginId: bb.pluginId,
        values: { claudeCodeOauthToken: token.trim() },
      });
      return { claudeCodeTokenSet: token.trim() !== "" };
    },
    auth_start: () => startSignIn(),
    auth_cancel: async () => {
      pending?.controller.abort();
      pending = null;
      return describeAuth();
    },
    auth_sign_out: () => signOut(),
    machines_list: () => describeMachines(),
    machines_create: async () => ({ started: await startCreate() }),
    machines_wake: async ({ name }) => ({ started: await startWake(name) }),
    machines_stop: async ({ name }) => ({
      stopped: await stopMachineByName(name),
    }),
    machines_remove: async ({ name }) => ({
      removed: await removeMachineByName(name),
    }),
    events_list: async () => ({ events: await readEvents() }),
    events_clear: async () => {
      const cleared = (await readEvents()).length;
      await bb.storage.kv.set("events", []);
      return { cleared };
    },
  });

  bb.onDispose(() => {
    pending?.controller.abort();
    bb.log.info("disposed");
  });
}
