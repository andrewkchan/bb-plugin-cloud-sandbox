// Vercel Sandbox integration core.
//
// Deliberately free of any bb.* dependency so it is unit-testable and reusable
// from both the plugin backend (server.ts) and the standalone verification
// script (scripts/verify-sandbox.ts).
import { Sandbox } from "@vercel/sandbox";

/**
 * Explicit Vercel API credentials. `@vercel/sandbox` requires all three or
 * none: when none are supplied it falls back to the `VERCEL_OIDC_TOKEN`
 * environment variable that `vercel env pull` writes into `.env.local`, and
 * derives the team and project from that token's claims.
 */
export interface SandboxCredentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** A single file staged into the sandbox before the command runs. */
export interface SandboxFile {
  /** Relative to /vercel/sandbox unless absolute. */
  path: string;
  content: string;
  /** POSIX mode, e.g. 0o755 for an executable script. */
  mode?: number;
}

export interface RunInSandboxOptions {
  /** Omit to authenticate from VERCEL_OIDC_TOKEN. */
  credentials?: SandboxCredentials;
  /** Files written into the sandbox before `cmd` runs. */
  files?: SandboxFile[];
  cmd: string;
  args?: string[];
  cwd?: string;
  /** Environment variables for the command. */
  env?: Record<string, string>;
  /**
   * VCR image to boot. Defaults to `vercel/sandbox/universal:latest`, which
   * carries Node and Python.
   */
  image?: string;
  /** vCPUs; the sandbox gets 2048 MB of memory per vCPU. */
  vcpus?: number;
  /** Milliseconds before the sandbox auto-terminates. Defaults to 5 minutes. */
  sandboxTimeoutMs?: number;
  /** Milliseconds before the command itself is SIGKILLed. */
  commandTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface RunInSandboxResult {
  /** The sandbox's generated name, useful for correlating with Vercel logs. */
  sandboxName: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  /** Wall-clock milliseconds spent booting the sandbox. */
  createdInMs: number;
  /** Wall-clock milliseconds spent running the command. */
  ranInMs: number;
}

const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60_000;

/**
 * Boot a Vercel Sandbox, stage `files`, run one command, and capture its
 * output. The sandbox is always stopped, including on failure — a leaked
 * sandbox keeps billing until its own timeout fires.
 */
export async function runInSandbox(
  options: RunInSandboxOptions,
): Promise<RunInSandboxResult> {
  const {
    credentials,
    files = [],
    cmd,
    args = [],
    cwd,
    env,
    image,
    vcpus,
    sandboxTimeoutMs = DEFAULT_SANDBOX_TIMEOUT_MS,
    commandTimeoutMs,
    signal,
  } = options;

  const createStartedAt = Date.now();
  const sandbox = await Sandbox.create({
    timeout: sandboxTimeoutMs,
    ...(image === undefined ? {} : { image }),
    ...(vcpus === undefined ? {} : { resources: { vcpus } }),
    ...(signal === undefined ? {} : { signal }),
    ...(credentials ?? {}),
  });
  const createdInMs = Date.now() - createStartedAt;

  try {
    if (files.length > 0) {
      await sandbox.writeFiles(files, signal === undefined ? {} : { signal });
    }

    const runStartedAt = Date.now();
    const finished = await sandbox.runCommand({
      cmd,
      args,
      ...(cwd === undefined ? {} : { cwd }),
      ...(env === undefined ? {} : { env }),
      ...(commandTimeoutMs === undefined
        ? {}
        : { timeoutMs: commandTimeoutMs }),
      ...(signal === undefined ? {} : { signal }),
    });
    const ranInMs = Date.now() - runStartedAt;

    // Read both streams before stopping the sandbox: output is fetched from
    // the running session, so a stopped sandbox has nothing left to serve.
    const [stdout, stderr] = await Promise.all([
      finished.stdout(),
      finished.stderr(),
    ]);

    return {
      sandboxName: sandbox.name,
      exitCode: finished.exitCode,
      stdout,
      stderr,
      createdInMs,
      ranInMs,
    };
  } finally {
    // Never let a stop failure mask the original error.
    await sandbox.stop().catch(() => undefined);
  }
}

/** Language presets for `runCode`. */
export const RUNTIMES = {
  node: { file: "snippet.mjs", cmd: "node" },
  python: { file: "snippet.py", cmd: "python3" },
} as const;

export type RuntimeName = keyof typeof RUNTIMES;

/**
 * Write a source snippet into a fresh sandbox and execute it with the
 * matching interpreter.
 */
export async function runCode(
  code: string,
  runtime: RuntimeName,
  options: Omit<RunInSandboxOptions, "cmd" | "args" | "files"> = {},
): Promise<RunInSandboxResult> {
  const preset = RUNTIMES[runtime];
  return runInSandbox({
    ...options,
    files: [{ path: preset.file, content: code }],
    cmd: preset.cmd,
    args: [preset.file],
  });
}
