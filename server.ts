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
  describeSandboxError,
  stopMachine,
  wakeMachine,
  type EnrollmentDetails,
  type SandboxCredentials,
} from "./machines.js";
import {
  buildImage,
  DEFAULT_REPOSITORY,
  deleteImagesForTag,
  findPreset,
  IMAGE_PRESETS,
  pruneUntaggedImages,
  type ImageEnvVar,
  type RegistryCleanupResult,
} from "./images.js";

/** Debug events kept for troubleshooting. Bounded to stay under the kv cap. */
const MAX_EVENTS = 200;
const MACHINES_CHANGED = "machines-changed";
const IMAGES_CHANGED = "images-changed";
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
    "image.registry-pruned",
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
  /** The image this machine was created from, if any. */
  imageId: z.string().nullable(),
  imageName: z.string().nullable(),
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
  /** Name of the image this machine was created from, if any. */
  imageName: z.string().nullable(),
  error: z.string().nullable(),
});
export type MachineView = z.infer<typeof machineViewSchema>;

const imageStatusSchema = z.enum(["pending", "building", "ready", "error"]);

const envVarSchema = z.object({
  key: z.string().min(1).max(200),
  value: z.string().max(10_000),
});

const imageSchema = z.object({
  id: z.string(),
  name: z.string(),
  commands: z.string(),
  env: z.array(envVarSchema),
  status: imageStatusSchema,
  /** Reference to pass to Sandbox.create, once a build has succeeded. */
  imageRef: z.string().nullable(),
  lastError: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type PluginImage = z.infer<typeof imageSchema>;

const buildSchema = z.object({
  id: z.string(),
  imageId: z.string(),
  status: z.enum(["building", "ready", "error"]),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  imageRef: z.string().nullable(),
  error: z.string().nullable(),
});
export type PluginBuild = z.infer<typeof buildSchema>;

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
    /** `force` bypasses the cache, for the page's manual Refresh. */
    input: z.object({ force: z.boolean() }),
    output: z.object({
      machines: z.array(machineViewSchema),
      signedIn: z.boolean(),
      /** True while a create is in flight, so the page can show a spinner. */
      creating: z.boolean(),
      /** Deep link to this project's sandboxes on vercel.com, when derivable. */
      vercelUrl: z.string().nullable(),
      /** Images that have been built, for the create button's picker. */
      readyImages: z.array(z.object({ id: z.string(), name: z.string() })),
      /** Which of those the create button uses unless told otherwise. */
      defaultImageId: z.string().nullable(),
      /** When the returned data was actually fetched from Vercel. */
      fetchedAt: z.number(),
      /** True when this answer is stale and a refresh is already running. */
      refreshing: z.boolean(),
      /**
       * The last background machine operation that failed. Create and wake
       * run detached, so without this their errors reach only the debug log
       * and the button appears to do nothing.
       */
      lastFailure: z
        .object({
          action: z.enum(["create", "wake"]),
          message: z.string(),
          /** HTTP status when Vercel rejected it; null for local failures. */
          status: z.number().nullable(),
          at: z.number(),
        })
        .nullable(),
    }),
  },
  machines_create: {
    input: z.object({ imageId: z.string().nullable() }),
    output: z.object({ started: z.boolean() }),
  },
  /** Resume a stopped machine and bring its bb daemon back. */
  machines_wake: {
    input: z.object({ name: z.string().min(1) }),
    output: z.object({ started: z.boolean() }),
  },
  machines_dismiss_failure: {
    input: z.null(),
    output: z.object({ dismissed: z.boolean() }),
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
  images_list: {
    input: z.null(),
    output: z.object({
      images: z.array(imageSchema),
      /** The repository's images on vercel.com, when derivable. */
      registryUrl: z.string().nullable(),
      /** Starting points offered by the Create image button. */
      presets: z.array(
        z.object({
          id: z.string(),
          label: z.string(),
          description: z.string(),
        }),
      ),
    }),
  },
  images_create: {
    input: z.object({ presetId: z.string() }),
    output: imageSchema,
  },
  images_update: {
    input: z.object({
      id: z.string(),
      name: z.string().min(1).max(80).optional(),
      commands: z.string().max(50_000).optional(),
      env: z.array(envVarSchema).max(100).optional(),
    }),
    output: imageSchema,
  },
  images_delete: {
    input: z.object({ id: z.string() }),
    output: z.object({ deleted: z.boolean() }),
  },
  images_build: {
    input: z.object({ id: z.string() }),
    output: z.object({ started: z.boolean() }),
  },
  builds_list: {
    input: z.object({ imageId: z.string() }),
    output: z.object({ builds: z.array(buildSchema) }),
  },
  build_log: {
    input: z.object({ id: z.string() }),
    output: z.object({ log: z.string() }),
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
  /** The last detached machine operation that failed, for the page to show. */
  let lastFailure: {
    action: "create" | "wake";
    message: string;
    status: number | null;
    at: number;
  } | null = null;

  // Images and their build logs live in the plugin's own SQLite rather than
  // kv: a build log routinely exceeds the 256KB kv value cap.
  const db = bb.storage.database();
  bb.storage.migrate(db, [
    `CREATE TABLE IF NOT EXISTS images (
       id TEXT PRIMARY KEY,
       name TEXT NOT NULL,
       commands TEXT NOT NULL DEFAULT '',
       env TEXT NOT NULL DEFAULT '[]',
       status TEXT NOT NULL DEFAULT 'pending',
       image_ref TEXT,
       last_error TEXT,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
    `CREATE TABLE IF NOT EXISTS builds (
       id TEXT PRIMARY KEY,
       image_id TEXT NOT NULL,
       status TEXT NOT NULL,
       started_at INTEGER NOT NULL,
       finished_at INTEGER,
       image_ref TEXT,
       error TEXT,
       log TEXT NOT NULL DEFAULT ''
     )`,
    `CREATE INDEX IF NOT EXISTS builds_by_image ON builds (image_id, started_at DESC)`,
  ]);

  interface ImageRow {
    id: string;
    name: string;
    commands: string;
    env: string;
    status: string;
    image_ref: string | null;
    last_error: string | null;
    created_at: number;
    updated_at: number;
  }

  function toImage(row: ImageRow): PluginImage {
    const parsed = z.array(envVarSchema).safeParse(JSON.parse(row.env));
    return {
      id: row.id,
      name: row.name,
      commands: row.commands,
      env: parsed.success ? parsed.data : [],
      status: imageStatusSchema.parse(row.status),
      imageRef: row.image_ref,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function listImages(): PluginImage[] {
    return db
      .prepare("SELECT * FROM images ORDER BY created_at DESC")
      .all()
      .map((row) => toImage(row as ImageRow));
  }

  function getImage(id: string): PluginImage | null {
    const row = db.prepare("SELECT * FROM images WHERE id = ?").get(id);
    return row === undefined ? null : toImage(row as ImageRow);
  }

  function setImageStatus(
    id: string,
    status: PluginImage["status"],
    fields: { imageRef?: string | null; lastError?: string | null } = {},
  ): void {
    db.prepare(
      `UPDATE images SET status = ?, updated_at = ?,
         image_ref = COALESCE(?, image_ref),
         last_error = ?
       WHERE id = ?`,
    ).run(
      status,
      Date.now(),
      fields.imageRef ?? null,
      fields.lastError ?? null,
      id,
    );
    bb.realtime.publish(IMAGES_CHANGED, {});
  }

  /** Images whose build is running in this plugin generation. */
  const building = new Set<string>();

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

  /** Credentials when signed in, null otherwise. */
  async function optionalCredentials(): Promise<SandboxCredentials | null> {
    const session = await ensureFreshSession();
    return session === null
      ? null
      : {
          token: session.accessToken,
          teamId: session.teamId,
          projectId: session.projectId,
        };
  }

  /**
   * Registry housekeeping. Never throws: a manifest that will not delete is
   * worth recording but must not fail the operation that triggered it.
   */
  async function recordCleanup(
    label: string,
    run: (credentials: SandboxCredentials) => Promise<RegistryCleanupResult>,
  ): Promise<void> {
    const credentials = await optionalCredentials();
    if (credentials === null) return;
    try {
      const result = await run(credentials);
      if (result.deleted.length === 0 && result.failures.length === 0) return;
      await record(
        "image.registry-pruned",
        null,
        `${label}: deleted ${result.deleted.length} manifest(s), freed ${(result.freedBytes / 1e6).toFixed(0)}MB` +
          (result.failures.length === 0
            ? ""
            : `; ${result.failures.length} failed: ${result.failures.join("; ")}`),
      );
    } catch (error) {
      bb.log.warn(
        `${label} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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
    return vercelProjectUrl(session, "sandboxes");
  }

  /** `https://vercel.com/<team>/<project>/<section>`, or null without a slug. */
  function vercelProjectUrl(
    session: StoredSession,
    section: string,
  ): string | null {
    if (session.teamSlug === null || session.teamSlug === "") return null;
    const project = session.projectSlug ?? session.projectId;
    if (project === "") return null;
    return `https://vercel.com/${encodeURIComponent(session.teamSlug)}/${encodeURIComponent(project)}/${section}`;
  }

  async function readRecords(): Promise<MachineRecord[]> {
    return (await bb.storage.kv.get<MachineRecord[]>("machines")) ?? [];
  }
  async function writeRecords(records: MachineRecord[]): Promise<void> {
    await bb.storage.kv.set("machines", records);
    invalidateMachines();
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
  /**
   * Listing machines costs a Vercel round trip for the sandbox list plus two
   * more per running machine for its session start, so it runs over a second
   * and grows with the fleet. The page mounts fresh every time its panel is
   * opened, which made every visit pay that again.
   *
   * Answers are cached and served stale while a refresh runs behind them, so
   * a revisit paints immediately and the page says it is refreshing.
   */
  const MACHINES_TTL_MS = 30_000;
  type MachinesSnapshot = Awaited<ReturnType<typeof describeMachines>>;
  let machinesCache: { value: MachinesSnapshot; at: number } | null = null;
  let machinesRefresh: Promise<void> | null = null;

  /** Drop the cache so the next read reflects a change this plugin just made. */
  function invalidateMachines(): void {
    machinesCache = null;
  }

  function refreshMachinesInBackground(): void {
    machinesRefresh ??= describeMachines()
      .then((value) => {
        machinesCache = { value, at: Date.now() };
        bb.realtime.publish(MACHINES_CHANGED, {});
      })
      .catch((error: unknown) => {
        // Keep serving the previous answer; the next read tries again.
        bb.log.warn(
          `machine refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      })
      .finally(() => {
        machinesRefresh = null;
      });
  }

  async function readMachines(force: boolean) {
    if (force || machinesCache === null) {
      const value = await describeMachines();
      machinesCache = { value, at: Date.now() };
      return { ...value, fetchedAt: machinesCache.at, refreshing: false };
    }
    const age = Date.now() - machinesCache.at;
    if (age > MACHINES_TTL_MS) refreshMachinesInBackground();
    return {
      ...machinesCache.value,
      fetchedAt: machinesCache.at,
      refreshing: age > MACHINES_TTL_MS,
    };
  }

  async function describeMachines(): Promise<{
    machines: MachineView[];
    signedIn: boolean;
    creating: boolean;
    vercelUrl: string | null;
    readyImages: { id: string; name: string }[];
    defaultImageId: string | null;
    lastFailure: typeof lastFailure;
  }> {
    const session = await ensureFreshSession();
    // Anything that has ever built successfully can still create a machine.
    // Keying this off status would strand a working image the moment a later
    // rebuild failed, even though its published manifest is untouched.
    const readyImages = listImages()
      .filter((image) => image.imageRef !== null)
      .map((image) => ({ id: image.id, name: image.name }));
    const defaultImageId = await resolveDefaultImageId(readyImages);

    if (session === null) {
      return {
        machines: [],
        signedIn: false,
        creating: creating.size > 0,
        vercelUrl: null,
        readyImages,
        defaultImageId,
        lastFailure,
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
          status: `Error (sandbox ${sandbox.status})`,
          uptimeMs: null,
          createdAt: sandbox.createdAt,
          sessionStartedAt,
          lastUsedAt,
          waking: waking.has(sandbox.name),
          imageName: record?.imageName ?? null,
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
          imageName: record?.imageName ?? null,
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
          imageName: record?.imageName ?? null,
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
        imageName: record?.imageName ?? null,
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
      readyImages,
      defaultImageId,
      lastFailure,
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

  /**
   * The image the create button uses by default: the one most recently used to
   * create a machine, falling back to the newest built image when that one is
   * gone or nothing has been created yet.
   */
  async function resolveDefaultImageId(
    readyImages: { id: string }[],
  ): Promise<string | null> {
    if (readyImages.length === 0) return null;
    const last = await bb.storage.kv.get<string>("lastImageId");
    if (
      typeof last === "string" &&
      readyImages.some((image) => image.id === last)
    ) {
      return last;
    }
    return readyImages[0]?.id ?? null;
  }

  async function startCreate(imageId: string | null): Promise<boolean> {
    const credentials = await requireCredentials();
    const values = await settings.get();
    const image = imageId === null ? null : getImage(imageId);
    if (imageId !== null && (image === null || image.imageRef === null)) {
      throw new Error(
        `Image ${imageId} has not been built, so no machine can be created from it.`,
      );
    }
    const seconds = Number.parseInt(values.machineTimeoutSeconds, 10);
    const timeoutMs =
      Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 2_700_000;
    const vcpus = Number.parseInt(values.machineVcpus, 10);

    // A new attempt supersedes whatever the last one reported.
    lastFailure = null;
    const ticket = randomUUID().slice(0, 8);
    creating.add(ticket);
    invalidateMachines();
    bb.realtime.publish(MACHINES_CHANGED, {});

    void (async () => {
      try {
        await record(
          "create.requested",
          null,
          image === null
            ? "Creating a cloud machine from the default sandbox image."
            : `Creating a cloud machine from image "${image.name}".`,
        );
        // Remember the choice so the button defaults to it next time.
        if (image !== null) await bb.storage.kv.set("lastImageId", image.id);
        const enrollment = await mintEnrollment();
        const result = await createMachine({
          credentials,
          enrollment,
          env: await agentEnv(),
          ...(image?.imageRef == null ? {} : { image: image.imageRef }),
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
                imageId: image?.id ?? null,
                imageName: image?.name ?? null,
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
        const failure = describeSandboxError(error);
        lastFailure = { action: "create", ...failure, at: Date.now() };
        await record(
          "create.failed",
          null,
          failure.status === null
            ? failure.message
            : `[${failure.status}] ${failure.message}`,
        );
      } finally {
        creating.delete(ticket);
        invalidateMachines();
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
    lastFailure = null;
    waking.add(name);
    invalidateMachines();
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
        const failure = describeSandboxError(error);
        lastFailure = { action: "wake", ...failure, at: Date.now() };
        await record(
          "wake.failed",
          name,
          failure.status === null
            ? failure.message
            : `[${failure.status}] ${failure.message}`,
        );
      } finally {
        waking.delete(name);
        invalidateMachines();
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
    invalidateMachines();
    bb.realtime.publish(MACHINES_CHANGED, {});
    return true;
  }

  if ((await readStoredSession()) === null) {
    bb.status.needsConfiguration(
      "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
    );
  }

  /**
   * Run a build to completion in the background.
   *
   * The log is written to the build row as it streams, so the UI can follow a
   * running build instead of waiting for the whole thing.
   */
  async function startBuild(imageId: string): Promise<boolean> {
    if (building.has(imageId)) return false;
    const image = getImage(imageId);
    if (image === null) throw new Error(`No image with id ${imageId}`);

    const session = await ensureFreshSession();
    if (session === null) {
      throw new Error(
        "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
      );
    }
    if (session.teamSlug === null || session.teamSlug === "") {
      throw new Error(
        "Vercel team slug is unknown, so the registry path cannot be built. Sign out and back in.",
      );
    }

    const buildId = randomUUID().slice(0, 8);
    db.prepare(
      "INSERT INTO builds (id, image_id, status, started_at, log) VALUES (?, ?, 'building', ?, '')",
    ).run(buildId, imageId, Date.now());
    building.add(imageId);
    setImageStatus(imageId, "building", { lastError: null });

    void (async () => {
      const appendLog = (chunk: string) => {
        db.prepare("UPDATE builds SET log = log || ? WHERE id = ?").run(
          chunk,
          buildId,
        );
        bb.realtime.publish(IMAGES_CHANGED, {});
      };
      try {
        const result = await buildImage({
          credentials: {
            token: session.accessToken,
            teamId: session.teamId,
            projectId: session.projectId,
          },
          teamSlug: session.teamSlug!,
          projectId: session.projectId,
          // The tag is the image id, so rebuilding replaces the image in place
          // rather than accumulating tags nobody can tell apart.
          tag: image.id,
          commands: image.commands,
          env: image.env as ImageEnvVar[],
          onLog: appendLog,
        });
        db.prepare(
          "UPDATE builds SET status = 'ready', finished_at = ?, image_ref = ? WHERE id = ?",
        ).run(Date.now(), result.imageRef, buildId);
        setImageStatus(imageId, "ready", { imageRef: result.imageRef });
        bb.log.info(`image ${image.name} built as ${result.imageRef}`);
        // Rebuilding a tag leaves the manifest it replaced untagged and full
        // size, so only the latest hash for each image is kept.
        await recordCleanup("prune after build", pruneUntaggedImages);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        db.prepare(
          "UPDATE builds SET status = 'error', finished_at = ?, error = ? WHERE id = ?",
        ).run(Date.now(), message, buildId);
        setImageStatus(imageId, "error", { lastError: message });
        bb.log.warn(`image ${image.name} build failed: ${message}`);
      } finally {
        building.delete(imageId);
        bb.realtime.publish(IMAGES_CHANGED, {});
      }
    })();
    return true;
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
    machines_list: ({ force }) => readMachines(force),
    machines_create: async ({ imageId }) => ({
      started: await startCreate(imageId),
    }),
    machines_wake: async ({ name }) => ({ started: await startWake(name) }),
    machines_dismiss_failure: () => {
      const dismissed = lastFailure !== null;
      lastFailure = null;
      return { dismissed };
    },
    machines_stop: async ({ name }) => ({
      stopped: await stopMachineByName(name),
    }),
    machines_remove: async ({ name }) => ({
      removed: await removeMachineByName(name),
    }),
    images_list: async () => {
      const session = await readStoredSession();
      return {
        images: listImages(),
        presets: IMAGE_PRESETS.map(({ id, label, description }) => ({
          id,
          label,
          description,
        })),
        registryUrl:
          session === null
            ? null
            : vercelProjectUrl(session, `images/${DEFAULT_REPOSITORY}`),
      };
    },
    images_create: ({ presetId }) => {
      const preset = findPreset(presetId);
      if (preset === null) throw new Error(`No image preset "${presetId}"`);
      const now = Date.now();
      const id = randomUUID().slice(0, 8);
      const count = (
        db.prepare("SELECT COUNT(*) AS n FROM images").get() as { n: number }
      ).n;
      // A preset only seeds the row; it is ordinary editable configuration
      // from here, not a link that keeps updating.
      db.prepare(
        `INSERT INTO images (id, name, commands, env, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
      ).run(
        id,
        count === 0 ? preset.name : `${preset.name} ${count + 1}`,
        preset.commands,
        JSON.stringify(preset.env),
        now,
        now,
      );
      bb.realtime.publish(IMAGES_CHANGED, {});
      const created = getImage(id);
      if (created === null) throw new Error("Image was not created.");
      return created;
    },
    images_update: ({ id, name, commands, env }) => {
      const existing = getImage(id);
      if (existing === null) throw new Error(`No image with id ${id}`);
      db.prepare(
        `UPDATE images SET name = ?, commands = ?, env = ?, updated_at = ? WHERE id = ?`,
      ).run(
        name ?? existing.name,
        commands ?? existing.commands,
        JSON.stringify(env ?? existing.env),
        Date.now(),
        id,
      );
      bb.realtime.publish(IMAGES_CHANGED, {});
      const updated = getImage(id);
      if (updated === null) throw new Error(`No image with id ${id}`);
      return updated;
    },
    images_delete: async ({ id }) => {
      db.prepare("DELETE FROM builds WHERE image_id = ?").run(id);
      const result = db.prepare("DELETE FROM images WHERE id = ?").run(id);
      bb.realtime.publish(IMAGES_CHANGED, {});
      // The tag is the image id, so this removes exactly this image's
      // manifest; the prune then catches anything it superseded.
      await recordCleanup("delete image from registry", (credentials) =>
        deleteImagesForTag(credentials, id),
      );
      await recordCleanup("prune after delete", pruneUntaggedImages);
      return { deleted: result.changes > 0 };
    },
    images_build: async ({ id }) => ({ started: await startBuild(id) }),
    builds_list: ({ imageId }) => ({
      builds: db
        .prepare(
          "SELECT id, image_id, status, started_at, finished_at, image_ref, error FROM builds WHERE image_id = ? ORDER BY started_at DESC LIMIT 50",
        )
        .all(imageId)
        .map((row) => {
          const build = row as {
            id: string;
            image_id: string;
            status: string;
            started_at: number;
            finished_at: number | null;
            image_ref: string | null;
            error: string | null;
          };
          return {
            id: build.id,
            imageId: build.image_id,
            status: build.status as PluginBuild["status"],
            startedAt: build.started_at,
            finishedAt: build.finished_at,
            imageRef: build.image_ref,
            error: build.error,
          };
        }),
    }),
    build_log: ({ id }) => {
      const row = db.prepare("SELECT log FROM builds WHERE id = ?").get(id);
      return { log: row === undefined ? "" : ((row as { log: string }).log ?? "") };
    },
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
