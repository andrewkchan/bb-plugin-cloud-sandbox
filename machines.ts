// Cloud machine lifecycle: a Vercel Sandbox that enrolls itself as a bb
// machine and stays running.
//
// Like auth.ts this module carries no bb dependency; the caller supplies the
// enrollment details it obtained from bb.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APIError, Sandbox, Snapshot } from "@vercel/sandbox";

/**
 * Explicit Vercel API credentials. `@vercel/sandbox` requires all three or
 * none: with none it falls back to the `VERCEL_OIDC_TOKEN` environment
 * variable and derives team and project from that token's claims.
 */
export interface SandboxCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/**
 * Every sandbox this plugin creates is named with this prefix so listing can
 * distinguish plugin-managed machines from sandboxes created by anything else
 * in the same Vercel project.
 */
export const MACHINE_NAME_PREFIX = "bb-machine-";

/** A failure from the Vercel API, separated from the plugin's own errors. */
export interface SandboxFailure {
  message: string;
  /** HTTP status when Vercel rejected the request; null for local failures. */
  status: number | null;
}

/**
 * Normalise an error into something worth showing a user.
 *
 * Vercel's own message carries the useful detail (quota names, reset dates),
 * but the SDK prefixes it with "Status code N is not ok:", which repeats the
 * status the caller already has.
 */
export function describeSandboxError(error: unknown): SandboxFailure {
  if (error instanceof APIError) {
    return {
      message: error.message.replace(/^Status code \d+ is not ok:\s*/u, ""),
      status: error.response.status,
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    status: null,
  };
}

/** What bb needs the machine to know in order to enroll itself. */
export interface EnrollmentDetails {
  joinCode: string;
  hostId: string;
  /** The publicly reachable bb server URL, from bb connect. */
  serverUrl: string;
  machineCode: string;
}

export interface MachineSandbox {
  name: string;
  status: "pending" | "running" | "stopping" | "stopped" | "failed" | "aborted" | "snapshotting";
  /** Epoch ms. */
  createdAt: number;
  /** Epoch ms the sandbox last changed state, per Vercel. */
  updatedAt: number;
  /** The session (VM) currently backing this sandbox, if any. */
  currentSessionId: string | null;
  /** Configured lifetime in ms, if the API reported one. */
  timeoutMs: number | null;
}

/**
 * Read one of the shell scripts a machine runs. They are real files under
 * scripts/ so they can be linted and read on their own; bb loads this plugin
 * either from source or from dist/server.js, so find the plugin root by its
 * package.json rather than guessing how deep this module sits.
 */
function readScript(name: string): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, "package.json"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot locate scripts/${name}`);
    dir = parent;
  }
  return readFileSync(join(dir, "scripts", name), "utf8");
}

/**
 * The helpers, carrying the supervisor they install. Prepended to each entry
 * script: only one file is sent to the sandbox, so there is nothing to source.
 * A replacer function keeps `$$` in the supervisor from being read as a
 * replacement pattern.
 */
const SHELL_LIB = readScript("lib.sh").replace(
  "__DAEMON_SUPERVISOR__\n",
  () => readScript("daemon-supervisor.sh"),
);

/** Enrollment takes its join code, host id, server URL and machine code as arguments. */
export const ENROLLMENT_SCRIPT = `${SHELL_LIB}\n${readScript("enroll.sh")}`;

export const WAKE_SCRIPT = `${SHELL_LIB}\n${readScript("wake.sh")}`;

/**
 * Create a sandbox that stays running and enroll it as a bb machine.
 *
 * Unlike runInSandbox this deliberately does NOT stop the sandbox — the whole
 * point is a machine that outlives the call. It is stopped on failure only,
 * so a half-enrolled VM does not bill until its own timeout.
 */
export async function createMachine(options: {
  credentials: SandboxCredentials;
  enrollment: EnrollmentDetails;
  /**
   * Environment variables for the machine, inherited by every command run on
   * it. Agent credentials arrive this way rather than through an image, so a
   * long-lived token never lands in a shared image layer.
   */
  env?: Record<string, string>;
  /**
   * A built image to boot from, as `repository:tag`. Omitted means Vercel's
   * default managed image, which carries none of bb's prerequisites.
   */
  image?: string;
  /** Sandbox lifetime; Vercel caps this at 45m on Hobby, 24h on Pro. */
  timeoutMs: number;
  vcpus?: number;
  signal?: AbortSignal;
  /** Called once the sandbox exists, before the slow enrollment starts. */
  onCreated?: (name: string) => void | Promise<void>;
}): Promise<{ name: string; enrollLog: string }> {
  const {
    credentials,
    enrollment,
    env,
    image,
    timeoutMs,
    vcpus,
    signal,
    onCreated,
  } = options;

  const sandbox = await Sandbox.create({
    ...credentials,
    name: `${MACHINE_NAME_PREFIX}${randomUUID().slice(0, 8)}`,
    timeout: timeoutMs,
    ...(env === undefined || Object.keys(env).length === 0 ? {} : { env }),
    ...(image === undefined || image === "" ? {} : { image }),
    // Vercel appears to keep one snapshot per sandbox already, so this is
    // insurance rather than a saving: it states the invariant the plugin
    // relies on instead of trusting an undocumented default. Waking needs
    // only the most recent snapshot, and evicted ones are deleted at once.
    keepLastSnapshots: { count: 1 },
    ...(vcpus === undefined ? {} : { resources: { vcpus } }),
    ...(signal === undefined ? {} : { signal }),
  });

  try {
    await onCreated?.(sandbox.name);

    const finished = await sandbox.runCommand({
      cmd: "bash",
      args: [
        "-lc",
        ENROLLMENT_SCRIPT,
        "bb-enroll",
        enrollment.joinCode,
        enrollment.hostId,
        enrollment.serverUrl,
        enrollment.machineCode,
      ],
      // Enrollment installs a compiler and builds native modules; on a cold
      // image this runs into minutes.
      timeoutMs: Math.min(timeoutMs, 20 * 60_000),
      ...(signal === undefined ? {} : { signal }),
    });

    const [stdout, stderr] = await Promise.all([
      finished.stdout(),
      finished.stderr(),
    ]);
    const enrollLog = `${stdout}\n${stderr}`.trim();

    if (finished.exitCode !== 0) {
      throw new Error(
        `Enrollment failed (exit ${finished.exitCode}). ${lastMeaningfulLine(enrollLog)}`,
      );
    }
    return { name: sandbox.name, enrollLog };
  } catch (error) {
    // A sandbox that failed to enroll is useless; do not leave it billing.
    await sandbox.stop().catch(() => undefined);
    throw error;
  }
}

/** Pull the most informative trailing line out of an installer log. */
function lastMeaningfulLine(log: string): string {
  const lines = log
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines[lines.length - 1] ?? "No output.";
}

/** Every plugin-managed sandbox, newest first. */
export async function listMachines(
  credentials: SandboxCredentials,
): Promise<MachineSandbox[]> {
  const paginator = await Sandbox.list({
    ...credentials,
    namePrefix: MACHINE_NAME_PREFIX,
    // The API rejects namePrefix unless it is sorting by name; this call
    // re-sorts by createdAt below anyway.
    sortBy: "name",
  });
  // toArray() flattens pages into individual sandboxes.
  const sandboxes = await paginator.toArray();
  return sandboxes
    .map((entry) => ({
      name: entry.name,
      status: entry.status,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      currentSessionId: entry.currentSessionId ?? null,
      timeoutMs: entry.timeout ?? null,
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Permanently delete a machine's sandbox and every snapshot belonging to it.
 *
 * Order matters. The sandbox is stopped first because stopping a persistent
 * sandbox can itself produce a snapshot, and snapshots are deleted before the
 * sandbox because `delete()` leaves the instance inert — any later call on it,
 * including listSnapshots, throws.
 *
 * A snapshot that will not delete does not block deleting the sandbox; the
 * failures are returned so the caller can report them rather than silently
 * leaving storage behind.
 */
export async function destroyMachine(
  credentials: SandboxCredentials,
  name: string,
): Promise<{ snapshotsDeleted: number; snapshotFailures: string[] }> {
  const sandbox = await Sandbox.get({ ...credentials, name });
  return deleteSandboxWithSnapshots(sandbox, credentials);
}

/**
 * Delete a sandbox and every snapshot belonging to it.
 *
 * Deleting a sandbox does NOT delete its snapshots: they outlive it and keep
 * counting against Snapshots Storage with no sandbox left to reach them. Every
 * path that disposes of a sandbox permanently — a deleted machine, a finished
 * image build — has to come through here.
 */
export async function deleteSandboxWithSnapshots(
  sandbox: Sandbox,
  credentials: SandboxCredentials,
): Promise<{ snapshotsDeleted: number; snapshotFailures: string[] }> {
  await sandbox.stop().catch(() => undefined);

  let snapshotsDeleted = 0;
  const snapshotFailures: string[] = [];
  const snapshots = await sandbox
    .listSnapshots()
    .then((paginator) => paginator.toArray())
    .catch((error: unknown) => {
      snapshotFailures.push(
        `could not list snapshots: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    });

  for (const entry of snapshots) {
    if (entry.status === "deleted") continue;
    try {
      const snapshot = await Snapshot.get({
        ...credentials,
        snapshotId: entry.id,
      });
      await snapshot.delete();
      snapshotsDeleted += 1;
    } catch (error) {
      snapshotFailures.push(
        `${entry.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  await sandbox.delete();
  return { snapshotsDeleted, snapshotFailures };
}


/**
 * Resume a stopped machine and make sure its bb daemon is running again.
 *
 * `resume: true` starts the session up front rather than waiting for the
 * first command to trigger it, so a failure to resume surfaces here.
 */
export async function wakeMachine(
  credentials: SandboxCredentials,
  name: string,
  signal?: AbortSignal,
): Promise<string> {
  const sandbox = await Sandbox.get({
    ...credentials,
    name,
    resume: true,
    ...(signal === undefined ? {} : { signal }),
  });
  const finished = await sandbox.runCommand({
    cmd: "bash",
    args: ["-lc", WAKE_SCRIPT],
    timeoutMs: 5 * 60_000,
    ...(signal === undefined ? {} : { signal }),
  });
  const [stdout, stderr] = await Promise.all([
    finished.stdout(),
    finished.stderr(),
  ]);
  if (finished.exitCode !== 0) {
    throw new Error(
      `Wake failed (exit ${finished.exitCode}). ${lastMeaningfulLine(`${stdout}\n${stderr}`)}`,
    );
  }
  return lastMeaningfulLine(stdout);
}

/**
 * When each machine's *current* session started.
 *
 * Sandbox `createdAt` is the wrong clock for uptime: resuming boots a new
 * session from the filesystem snapshot, so a machine that has been stopped and
 * woken has a creation time far older than the VM actually running. The
 * session list carries the real start.
 *
 * This costs one request per machine, so callers should pass only the machines
 * that are actually up — a stopped machine has no uptime to show.
 */
export async function fetchSessionStarts(
  credentials: SandboxCredentials,
  machines: { name: string; currentSessionId: string | null }[],
): Promise<Map<string, number>> {
  const entries = await Promise.all(
    machines.map(async (machine) => {
      try {
        const sandbox = await Sandbox.get({ ...credentials, name: machine.name });
        const sessions = await sandbox
          .listSessions({ limit: 5, sortOrder: "desc" })
          .then((paginator) => paginator.toArray());
        const current =
          sessions.find((session) => session.id === machine.currentSessionId) ??
          sessions[0];
        if (current === undefined) return null;
        // startedAt is when the VM actually came up; createdAt is when the
        // session was requested, which is close enough when it is missing.
        const started = current.startedAt ?? current.createdAt;
        return [machine.name, started] as const;
      } catch {
        // A machine whose sessions cannot be read simply has no uptime shown.
        return null;
      }
    }),
  );
  return new Map(entries.filter((entry) => entry !== null));
}

/** Stop one machine's sandbox. Safe to call on an already-stopped sandbox. */
export async function stopMachine(
  credentials: SandboxCredentials,
  name: string,
): Promise<void> {
  const sandbox = await Sandbox.get({ ...credentials, name });
  await sandbox.stop();
}
