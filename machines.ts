// Cloud machine lifecycle: a Vercel Sandbox that enrolls itself as a bb
// machine and stays running.
//
// Like auth.ts this module carries no bb dependency; the caller supplies the
// enrollment details it obtained from bb.
import { randomUUID } from "node:crypto";
import { Sandbox, Snapshot } from "@vercel/sandbox";

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
 * The script a fresh sandbox runs to become a bb machine.
 *
 * Three things here are not obvious and were each found by watching a real
 * enrollment fail:
 *
 * 1. `build-essential` — the Vercel universal image ships Node but no C
 *    toolchain, and bb-app's node-pty dependency is a native add-on that npm
 *    compiles from source. Without it the install dies at `not found: make`.
 * 2. `BB_INSTALL_SKIP_SERVICE=1` — the installer's last step registers a
 *    systemd user service, and containers have no systemd (`systemctl: not
 *    found`). This flag leaves the already-joined daemon running as a plain
 *    nohup'd process instead, which is what we want in a disposable VM.
 * 3. The server URL must be the bb connect tunnel URL, not a loopback
 *    address — the sandbox is on the public internet and cannot reach
 *    127.0.0.1.
 */
export function buildEnrollmentScript(details: EnrollmentDetails): string {
  const { joinCode, hostId, serverUrl, machineCode } = details;
  return [
    "set -e",
    "sudo apt-get update -qq",
    "sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq build-essential >/dev/null 2>&1",
    "export BB_INSTALL_SKIP_SERVICE=1",
    `curl -fL --connect-timeout 10 --max-time 60 --retry 2 ${serverUrl}/install.sh | sh -s -- --join-code ${joinCode} --host-id ${hostId} --server ${serverUrl} --machine-code ${machineCode}`,
  ].join("\n");
}

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
  /** Sandbox lifetime; Vercel caps this at 45m on Hobby, 24h on Pro. */
  timeoutMs: number;
  vcpus?: number;
  signal?: AbortSignal;
  /** Called once the sandbox exists, before the slow enrollment starts. */
  onCreated?: (name: string) => void | Promise<void>;
}): Promise<{ name: string; enrollLog: string }> {
  const { credentials, enrollment, timeoutMs, vcpus, signal, onCreated } =
    options;

  const sandbox = await Sandbox.create({
    ...credentials,
    name: `${MACHINE_NAME_PREFIX}${randomUUID().slice(0, 8)}`,
    timeout: timeoutMs,
    ...(vcpus === undefined ? {} : { resources: { vcpus } }),
    ...(signal === undefined ? {} : { signal }),
  });

  try {
    await onCreated?.(sandbox.name);

    const finished = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", buildEnrollmentScript(enrollment)],
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
 * Bring a stopped machine back.
 *
 * Resuming restores the microVM from its snapshot, and because that snapshot
 * carries memory as well as disk, the host daemon usually comes back running
 * on its own — with the same hostId, since the durable credentials in
 * ~/.bb-machines survive too. This script is the belt-and-braces half: it
 * relaunches the daemon only if the restore did not bring it back, so a cold
 * disk-only restore still reconnects.
 *
 * Everything it needs is already on disk. The data directory is discovered
 * rather than derived from a server URL, because bb connect can mint a
 * different tunnel URL than the one the machine originally enrolled against.
 */
export function buildWakeScript(): string {
  // Liveness is checked against the daemon's own /status endpoint, the same
  // signal bb's installer waits on. Matching on a process name would be wrong
  // here: `pgrep -f "bb-app host-daemon"` also matches the shell running this
  // script, because the pattern appears in its own command line, so it always
  // reports a running daemon and the relaunch below never happens.
  const isConnected = `curl -sf --max-time 2 "http://127.0.0.1:$PORT/status" 2>/dev/null | grep -q '"connected"[[:space:]]*:[[:space:]]*true'`;
  return [
    "set -e",
    'DATA=$(find "$HOME/.bb-machines" -maxdepth 1 -mindepth 1 -type d ! -name host-daemon-ports | head -1)',
    '[ -n "$DATA" ] || { echo "no bb enrollment found in this sandbox"; exit 1; }',
    'PORT=$(cat "$DATA/host-daemon-port" 2>/dev/null || echo 38888)',
    `SERVER=$(node -e 'console.log(require(process.argv[1]).serverUrl)' "$DATA/config.json")`,
    `if ${isConnected}; then echo "daemon already connected"; exit 0; fi`,
    'BB_APP_NPM_PREFIX="$DATA/npm" BB_DATA_DIR="$DATA" nohup "$DATA/npm/bin/bb-app" host-daemon --auto-update --host-daemon-port "$PORT" --server-url "$SERVER" >> "$DATA/wake.log" 2>&1 &',
    // Return only once the machine is genuinely usable again, not merely
    // once a process has been spawned.
    "i=0",
    "while [ $i -lt 60 ]; do",
    `  if ${isConnected}; then echo "daemon reconnected"; exit 0; fi`,
    "  i=$((i+1)); sleep 2",
    "done",
    'echo "daemon did not reconnect; see $DATA/wake.log"; exit 1',
  ].join("\n");
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
    args: ["-lc", buildWakeScript()],
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
