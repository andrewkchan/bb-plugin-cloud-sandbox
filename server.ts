// bb-plugin-cloud-sandbox — run code in a Vercel Sandbox from bb.
//
// The interface is entirely graphical: a Cloud Sandbox page for running code
// and a settings section for connecting a Vercel account. Authentication is
// OAuth device authorization — the user clicks "Sign in with Vercel", approves
// in the browser, and the plugin resolves (and if necessary creates) the Vercel
// team and project itself. No CLI, no access token to copy, no ids to look up.
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { inferScope } from "@vercel/sandbox/dist/auth/index.js";
import {
  DEFAULT_CLIENT_ID,
  pollForSession,
  refreshSession,
  revokeToken,
  startDeviceAuthorization,
  type AuthSession,
  type DeviceAuthorization,
} from "./auth.js";
import {
  runCode,
  type RuntimeName,
  type SandboxCredentials,
} from "./sandbox.js";

const MAX_OUTPUT_CHARS = 20_000;
const MAX_HISTORY = 25;
const RUNS_CHANGED = "runs-changed";
const AUTH_CHANGED = "auth-changed";
/** Refresh this long before the access token actually expires. */
const REFRESH_SKEW_MS = 60_000;

const runtimeSchema = z.enum(["node", "python"]);

const runRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  runtime: runtimeSchema.nullable(),
  input: z.string(),
  sandboxName: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  createdInMs: z.number(),
  ranInMs: z.number(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

/** Everything the sign-in flow persists, stored as one secret setting. */
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

const authStatusSchema = z.object({
  state: z.enum(["signed-out", "pending", "signed-in"]),
  /** Present while `state` is "pending". */
  verificationUriComplete: z.string().nullable(),
  userCode: z.string().nullable(),
  /** Present once signed in. */
  teamSlug: z.string().nullable(),
  projectSlug: z.string().nullable(),
  /** Set when the last sign-in attempt failed. */
  error: z.string().nullable(),
});

export type AuthStatus = z.infer<typeof authStatusSchema>;

export const rpcContract = defineRpcContract({
  auth_status: { input: z.null(), output: authStatusSchema },
  auth_start: { input: z.null(), output: authStatusSchema },
  auth_cancel: { input: z.null(), output: authStatusSchema },
  auth_sign_out: { input: z.null(), output: authStatusSchema },
  runs_list: {
    input: z.null(),
    output: z.object({ runs: z.array(runRecordSchema) }),
  },
  runs_clear: { input: z.null(), output: z.object({ cleared: z.number() }) },
  run_code: {
    input: z.object({
      code: z.string().min(1).max(100_000),
      runtime: runtimeSchema,
    }),
    output: runRecordSchema,
  },
});

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n… truncated ${text.length - MAX_OUTPUT_CHARS} more characters`;
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    // Written by the sign-in flow, not by hand. It lives in a secret setting
    // so it lands in the plugin's 0600 secrets directory rather than bb.db.
    vercelSession: {
      type: "string",
      label: "Vercel session (managed by Sign in with Vercel)",
      secret: true,
    },
    oauthClientId: {
      type: "string",
      label: "OAuth client ID (blank uses the Vercel SDK's own client)",
      default: "",
    },
    defaultRuntime: {
      type: "select",
      label: "Default runtime",
      options: ["node", "python"],
      default: "node",
    },
    sandboxTimeoutSeconds: {
      type: "string",
      label: "Sandbox timeout (seconds)",
      default: "300",
    },
  });

  // In-memory sign-in attempt. Deliberately not persisted: a device code is
  // short-lived, and a reload should drop a half-finished flow rather than
  // resume one the user has forgotten about.
  let pending: {
    authorization: DeviceAuthorization;
    controller: AbortController;
  } | null = null;
  let lastAuthError: string | null = null;
  /** De-duplicates concurrent refreshes so two runs cannot race. */
  let refreshInFlight: Promise<StoredSession> | null = null;

  async function readClientId(): Promise<string> {
    const { oauthClientId } = await settings.get();
    const trimmed = oauthClientId.trim();
    return trimmed === "" ? DEFAULT_CLIENT_ID : trimmed;
  }

  async function readStoredSession(): Promise<StoredSession | null> {
    const { vercelSession } = await settings.get();
    if (vercelSession === undefined || vercelSession.trim() === "") return null;
    const parsed = storedSessionSchema.safeParse(
      JSON.parse(vercelSession) as unknown,
    );
    return parsed.success ? parsed.data : null;
  }

  /**
   * Persist through the settings route, because a settings handle is
   * read-only by design. Writing the plugin's own id is the sanctioned way
   * for a plugin to update a value the user did not type.
   */
  async function writeStoredSession(session: StoredSession | null) {
    await bb.sdk.plugins.updateSettings({
      pluginId: bb.pluginId,
      values: { vercelSession: session === null ? "" : JSON.stringify(session) },
    });
  }

  async function describeAuth(): Promise<z.infer<typeof authStatusSchema>> {
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
   * Turn a fresh OAuth session into a stored one by resolving the Vercel team
   * and project, creating a default project when the user has none.
   *
   * `cwd` is pinned to a temp directory on purpose: inferScope otherwise reads
   * `.vercel/project.json` relative to `process.cwd()`, which is wherever the
   * bb server happened to be launched — it must not silently adopt an
   * unrelated linked project.
   */
  async function resolveScope(session: AuthSession): Promise<StoredSession> {
    const scope = await inferScope({
      token: session.accessToken,
      cwd: tmpdir(),
    });
    if (scope.created) {
      bb.log.info(
        `created Vercel project ${scope.projectId} in team ${scope.teamId}`,
      );
    }
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

  /** Return a session whose access token is good for at least REFRESH_SKEW_MS. */
  async function ensureFreshSession(): Promise<StoredSession | null> {
    const stored = await readStoredSession();
    if (stored === null) return null;
    if (stored.expiresAt - REFRESH_SKEW_MS > Date.now()) return stored;
    if (stored.refreshToken === null) return stored;

    refreshInFlight ??= (async () => {
      const clientId = await readClientId();
      const refreshed = await refreshSession(stored.refreshToken!, clientId);
      const next: StoredSession = { ...stored, ...refreshed };
      await writeStoredSession(next);
      return next;
    })().finally(() => {
      refreshInFlight = null;
    });
    return refreshInFlight;
  }

  async function readRuns(): Promise<RunRecord[]> {
    return (await bb.storage.kv.get<RunRecord[]>("runs")) ?? [];
  }
  async function recordRun(run: RunRecord): Promise<RunRecord> {
    const runs = [run, ...(await readRuns())].slice(0, MAX_HISTORY);
    await bb.storage.kv.set("runs", runs);
    bb.realtime.publish(RUNS_CHANGED, { count: runs.length });
    return run;
  }

  async function resolveConfig(): Promise<{
    credentials: SandboxCredentials | undefined;
    defaultRuntime: RuntimeName;
    sandboxTimeoutMs: number;
  }> {
    const values = await settings.get();
    const session = await ensureFreshSession();
    const seconds = Number.parseInt(values.sandboxTimeoutSeconds, 10);
    return {
      credentials:
        session === null
          ? undefined
          : {
              token: session.accessToken,
              teamId: session.teamId,
              projectId: session.projectId,
            },
      defaultRuntime: values.defaultRuntime as RuntimeName,
      sandboxTimeoutMs:
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300_000,
    };
  }

  if ((await readStoredSession()) === null) {
    bb.status.needsConfiguration(
      "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
    );
  }

  /** Drive a sign-in to completion in the background. */
  function beginSignIn(authorization: DeviceAuthorization, clientId: string) {
    const controller = new AbortController();
    pending = { authorization, controller };
    lastAuthError = null;

    void (async () => {
      try {
        const session = await pollForSession(
          authorization,
          clientId,
          controller.signal,
        );
        const stored = await resolveScope(session);
        pending = null;
        // Written last: persisting while the plugin is in needs-configuration
        // makes bb retry the load, which replaces this generation and makes
        // the captured `bb` handle stale.
        await writeStoredSession(stored);
      } catch (error) {
        pending = null;
        lastAuthError = error instanceof Error ? error.message : String(error);
        bb.log.warn(`sign-in failed: ${lastAuthError}`);
      }
      try {
        bb.realtime.publish(AUTH_CHANGED, {});
      } catch {
        // The generation was replaced by the settings write above; the next
        // load reports the new state anyway.
      }
    })();
  }

  async function startSignIn() {
    if (pending !== null) return describeAuth();
    if ((await readStoredSession()) !== null) return describeAuth();
    const clientId = await readClientId();
    const authorization = await startDeviceAuthorization(clientId);
    beginSignIn(authorization, clientId);
    return describeAuth();
  }

  async function signOut() {
    pending?.controller.abort();
    pending = null;
    lastAuthError = null;
    const stored = await readStoredSession();
    if (stored !== null) {
      // Best effort: a failed revocation must not strand the local session.
      await revokeToken(stored.accessToken, await readClientId()).catch(
        () => undefined,
      );
      await writeStoredSession(null);
    }
    return describeAuth();
  }

  async function execute(
    code: string,
    runtime: RuntimeName,
  ): Promise<RunRecord> {
    const config = await resolveConfig();
    if (config.credentials === undefined) {
      throw new Error(
        "Not signed in to Vercel. Use Sign in with Vercel on this plugin's settings page.",
      );
    }
    const result = await runCode(code, runtime, {
      credentials: config.credentials,
      sandboxTimeoutMs: config.sandboxTimeoutMs,
      commandTimeoutMs: config.sandboxTimeoutMs,
    });

    return recordRun({
      id: randomUUID().slice(0, 8),
      startedAt: new Date().toISOString(),
      runtime,
      input: truncate(code),
      sandboxName: result.sandboxName,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      createdInMs: result.createdInMs,
      ranInMs: result.ranInMs,
    });
  }

  bb.rpc.register(rpcContract, {
    auth_status: () => describeAuth(),
    auth_start: () => startSignIn(),
    auth_cancel: async () => {
      pending?.controller.abort();
      pending = null;
      return describeAuth();
    },
    auth_sign_out: () => signOut(),
    runs_list: async () => ({ runs: await readRuns() }),
    runs_clear: async () => {
      const cleared = (await readRuns()).length;
      await bb.storage.kv.set("runs", []);
      bb.realtime.publish(RUNS_CHANGED, { count: 0 });
      return { cleared };
    },
    run_code: ({ code, runtime }) => execute(code, runtime),
  });

  bb.onDispose(() => {
    pending?.controller.abort();
    bb.log.info("disposed");
  });
}
