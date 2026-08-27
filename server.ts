// bb-plugin-cloud-sandbox — run code in a Vercel Sandbox from bb.
//
// One core (sandbox.ts) serves three surfaces: the Cloud Sandbox page
// (app.tsx, over RPC), the `bb cloud-sandbox` CLI command that agents use,
// and the skill in skills/cloud-sandbox/SKILL.md that tells them how.
// Every run is appended to a bounded history in bb.storage.kv and announced
// on a realtime channel so open pages refetch.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  RUNTIMES,
  runCode,
  runInSandbox,
  type RuntimeName,
  type SandboxCredentials,
} from "./sandbox.js";

/** Per-stream output kept in history and returned over RPC. */
const MAX_OUTPUT_CHARS = 20_000;
/** How many past runs the history keeps. Bounded to stay under the kv cap. */
const MAX_HISTORY = 25;
/** Realtime channel app.tsx listens on. */
const RUNS_CHANGED = "runs-changed";

const runtimeSchema = z.enum(["node", "python"]);

const runRecordSchema = z.object({
  id: z.string(),
  startedAt: z.string(),
  kind: z.enum(["code", "exec"]),
  runtime: runtimeSchema.nullable(),
  /** The snippet for a `code` run, or the command line for an `exec` run. */
  input: z.string(),
  sandboxName: z.string(),
  exitCode: z.number(),
  stdout: z.string(),
  stderr: z.string(),
  createdInMs: z.number(),
  ranInMs: z.number(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export const rpcContract = defineRpcContract({
  status: {
    input: z.null(),
    output: z.object({
      configured: z.boolean(),
      /** Which settings are still missing, for the UI to name them. */
      missing: z.array(z.string()),
      defaultRuntime: runtimeSchema,
    }),
  },
  runs_list: {
    input: z.null(),
    output: z.object({ runs: z.array(runRecordSchema) }),
  },
  runs_clear: {
    input: z.null(),
    output: z.object({ cleared: z.number() }),
  },
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

  // A Vercel personal access token plus the team and project it acts on.
  // @vercel/sandbox needs all three together; it otherwise falls back to a
  // VERCEL_OIDC_TOKEN in the environment, which expires too quickly to be a
  // sensible fit for a long-lived server, so this plugin asks for the token.
  const settings = bb.settings.define({
    vercelToken: {
      type: "string",
      label: "Vercel access token",
      secret: true,
    },
    teamId: {
      type: "string",
      label: "Vercel team ID",
      default: "",
    },
    projectId: {
      type: "string",
      label: "Vercel project ID",
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

  /**
   * Re-read settings on every run so a token edit takes effect without a
   * plugin reload.
   */
  async function resolveConfig(): Promise<{
    credentials: SandboxCredentials | undefined;
    missing: string[];
    defaultRuntime: RuntimeName;
    sandboxTimeoutMs: number;
  }> {
    const values = await settings.get();
    const token = values.vercelToken?.trim() ?? "";
    const teamId = values.teamId.trim();
    const projectId = values.projectId.trim();
    const missing = [
      token === "" ? "vercelToken" : null,
      teamId === "" ? "teamId" : null,
      projectId === "" ? "projectId" : null,
    ].filter((value): value is string => value !== null);

    const seconds = Number.parseInt(values.sandboxTimeoutSeconds, 10);
    return {
      credentials:
        missing.length === 0 ? { token, teamId, projectId } : undefined,
      missing,
      // The descriptor's options are exactly the runtime names.
      defaultRuntime: values.defaultRuntime as RuntimeName,
      sandboxTimeoutMs:
        Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 300_000,
    };
  }

  const initial = await resolveConfig();
  if (initial.missing.length > 0) {
    bb.status.needsConfiguration(
      `Set ${initial.missing.join(", ")} with \`bb plugin config cloud-sandbox set <key> <value>\`, then reload. Create a token at https://vercel.com/account/tokens.`,
    );
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

  /**
   * Shared execution path. Throws a message naming the missing settings when
   * the plugin is not configured, so every surface reports it the same way.
   */
  async function execute(params: {
    kind: RunRecord["kind"];
    runtime: RuntimeName | null;
    input: string;
    code?: string;
    cmd?: string;
    args?: string[];
  }): Promise<RunRecord> {
    const config = await resolveConfig();
    if (config.credentials === undefined) {
      throw new Error(
        `Cloud Sandbox is not configured: set ${config.missing.join(", ")} with \`bb plugin config cloud-sandbox set <key> <value>\`.`,
      );
    }
    const options = {
      credentials: config.credentials,
      sandboxTimeoutMs: config.sandboxTimeoutMs,
      commandTimeoutMs: config.sandboxTimeoutMs,
    };

    const result =
      params.code === undefined
        ? await runInSandbox({
            ...options,
            cmd: params.cmd ?? "",
            args: params.args ?? [],
          })
        : await runCode(params.code, params.runtime ?? "node", options);

    return recordRun({
      id: randomUUID().slice(0, 8),
      startedAt: new Date().toISOString(),
      kind: params.kind,
      runtime: params.runtime,
      input: truncate(params.input),
      sandboxName: result.sandboxName,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout),
      stderr: truncate(result.stderr),
      createdInMs: result.createdInMs,
      ranInMs: result.ranInMs,
    });
  }

  bb.rpc.register(rpcContract, {
    status: async () => {
      const config = await resolveConfig();
      return {
        configured: config.credentials !== undefined,
        missing: config.missing,
        defaultRuntime: config.defaultRuntime,
      };
    },
    runs_list: async () => ({ runs: await readRuns() }),
    runs_clear: async () => {
      const cleared = (await readRuns()).length;
      await bb.storage.kv.set("runs", []);
      bb.realtime.publish(RUNS_CHANGED, { count: 0 });
      return { cleared };
    },
    run_code: ({ code, runtime }) =>
      execute({ kind: "code", runtime, input: code, code }),
  });

  // The `bb cloud-sandbox` command. `run` executes on the SERVER, so this
  // command deliberately takes code and arguments inline rather than reading
  // a path — a path would name a file on the invoking machine, which may not
  // be the server's.
  const usage = [
    "Usage:",
    "  bb cloud-sandbox status [--json]",
    "  bb cloud-sandbox run [--runtime node|python] <code> [--json]",
    "  bb cloud-sandbox exec <cmd> [args...] [--json]",
    "  bb cloud-sandbox history [--json]",
    "",
    "Examples:",
    '  bb cloud-sandbox run \'console.log(1 + 1)\'',
    "  bb cloud-sandbox run --runtime python 'print(sum(range(10)))'",
    "  bb cloud-sandbox exec bash -lc 'uname -a && node --version'",
  ].join("\n");

  function formatRun(run: RunRecord): string {
    const lines = [
      `${run.id}  exit ${run.exitCode}  sandbox ${run.sandboxName}  (boot ${run.createdInMs}ms, run ${run.ranInMs}ms)`,
    ];
    if (run.stdout.trim() !== "") lines.push("--- stdout ---", run.stdout.trimEnd());
    if (run.stderr.trim() !== "") lines.push("--- stderr ---", run.stderr.trimEnd());
    return lines.join("\n");
  }

  bb.cli.register({
    name: "cloud-sandbox",
    summary: "Run code and commands in an isolated Vercel Sandbox",
    commands: [
      {
        name: "status",
        summary: "Show whether Vercel credentials are configured",
        usage: "bb cloud-sandbox status [--json]",
      },
      {
        name: "run",
        summary: "Run a code snippet in a fresh sandbox and capture its output",
        usage:
          "bb cloud-sandbox run [--runtime node|python] <code> [--json]",
      },
      {
        name: "exec",
        summary: "Run a shell command in a fresh sandbox and capture its output",
        usage: "bb cloud-sandbox exec <cmd> [args...] [--json]",
      },
      {
        name: "history",
        summary: "List recent sandbox runs",
        usage: "bb cloud-sandbox history [--json]",
      },
    ],
    async run(argv) {
      const json = argv.includes("--json");
      const rest = argv.filter((arg) => arg !== "--json");
      const [command, ...args] = rest;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };

          case "status": {
            const config = await resolveConfig();
            const configured = config.credentials !== undefined;
            return reply(
              {
                configured,
                missing: config.missing,
                defaultRuntime: config.defaultRuntime,
                sandboxTimeoutMs: config.sandboxTimeoutMs,
              },
              configured
                ? `Configured. Default runtime: ${config.defaultRuntime}, sandbox timeout ${config.sandboxTimeoutMs / 1000}s.`
                : `Not configured. Missing: ${config.missing.join(", ")}.\nSet each with \`bb plugin config cloud-sandbox set <key> <value>\`.`,
            );
          }

          case "run": {
            let runtime: RuntimeName = (await resolveConfig()).defaultRuntime;
            const positional = [...args];
            const flagIndex = positional.indexOf("--runtime");
            if (flagIndex !== -1) {
              const value = positional[flagIndex + 1];
              if (value !== "node" && value !== "python") {
                return {
                  exitCode: 1,
                  stderr: `--runtime must be one of ${Object.keys(RUNTIMES).join(", ")}.`,
                };
              }
              runtime = value;
              positional.splice(flagIndex, 2);
            }
            const code = positional.join(" ").trim();
            if (code === "") break;
            const run = await execute({
              kind: "code",
              runtime,
              input: code,
              code,
            });
            return reply(run, formatRun(run));
          }

          case "exec": {
            const [cmd, ...cmdArgs] = args;
            if (cmd === undefined) break;
            const run = await execute({
              kind: "exec",
              runtime: null,
              input: [cmd, ...cmdArgs].join(" "),
              cmd,
              args: cmdArgs,
            });
            return reply(run, formatRun(run));
          }

          case "history": {
            const runs = await readRuns();
            return reply(
              runs,
              runs.length === 0
                ? "No runs yet."
                : runs
                    .map(
                      (run) =>
                        `${run.id}  ${run.startedAt}  exit ${run.exitCode}  ${run.kind}  ${run.input.split("\n")[0].slice(0, 60)}`,
                    )
                    .join("\n"),
            );
          }
        }
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
      return { exitCode: 1, stderr: usage };
    },
  });

  bb.onDispose(() => {
    bb.log.info("disposed");
  });
}
