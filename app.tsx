// bb-plugin-cloud-sandbox — a BB plugin frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time (never
// bundled), so this file must be loaded by BB, not imported directly.
//
// The components under components/ui/ are YOURS: vendored source (shadcn
// model), edit freely. Add more from the BB registry with
// `npx shadcn add @bb/<name>` (see components.json).
import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract, RunRecord } from "./server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type Runtime = "node" | "python";

const PLACEHOLDER: Record<Runtime, string> = {
  node: 'console.log("hello from the sandbox");',
  python: 'print("hello from the sandbox")',
};

function useSandbox() {
  const rpc = useRpc<typeof rpcContract>();
  const [runs, setRuns] = useState<RunRecord[] | null>(null);
  const [missing, setMissing] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("runs_list").then((result) => setRuns(result.runs), report);
    rpc.call("status").then((result) => setMissing(result.missing), report);
  }, [rpc, report]);

  useEffect(refetch, [refetch]);
  // server.ts publishes after every run — from this page, another window, or
  // `bb cloud-sandbox run` invoked by an agent — so the list never goes stale.
  useRealtime("runs-changed", refetch);

  return { rpc, runs, missing, error, setError, report, refetch };
}

function OutputBlock({ label, text }: { label: string; text: string }) {
  if (text.trim() === "") return null;
  return (
    <div className="mt-2">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <pre className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs whitespace-pre-wrap">
        {text.trimEnd()}
      </pre>
    </div>
  );
}

function RunCard({ run }: { run: RunRecord }) {
  const failed = run.exitCode !== 0;
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        <span
          className={cn(
            "font-medium",
            failed ? "text-destructive" : "text-foreground",
          )}
        >
          exit {run.exitCode}
        </span>
        <span className="text-muted-foreground">
          {run.runtime ?? "command"} · boot {run.createdInMs}ms · run{" "}
          {run.ranInMs}ms
        </span>
        <span className="ml-auto font-mono text-muted-foreground">
          {run.sandboxName}
        </span>
      </div>
      <pre className="mt-2 max-h-32 overflow-auto font-mono text-xs whitespace-pre-wrap text-muted-foreground">
        {run.input}
      </pre>
      <OutputBlock label="stdout" text={run.stdout} />
      <OutputBlock label="stderr" text={run.stderr} />
    </li>
  );
}

function SandboxPage() {
  const { rpc, runs, missing, error, setError, report, refetch } = useSandbox();
  const [runtime, setRuntime] = useState<Runtime>("node");
  const [code, setCode] = useState("");
  const [isRunning, setIsRunning] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (trimmed === "" || isRunning) return;
    setIsRunning(true);
    setError(null);
    rpc.call("run_code", { code: trimmed, runtime }).then(
      () => {
        setIsRunning(false);
        refetch();
      },
      (cause: unknown) => {
        setIsRunning(false);
        report(cause);
      },
    );
  };

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        {missing !== null && missing.length > 0 ? (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Cloud Sandbox is not configured.</p>
            <p className="mt-1 text-muted-foreground">
              Missing: {missing.join(", ")}. Set each with{" "}
              <code className="font-mono">
                bb plugin config cloud-sandbox set &lt;key&gt; &lt;value&gt;
              </code>
              , or use this plugin&apos;s settings page. Create a token at
              vercel.com/account/tokens.
            </p>
          </div>
        ) : null}

        <form onSubmit={submit} className="space-y-2">
          <div className="flex items-center gap-2">
            {(["node", "python"] as const).map((candidate) => (
              <Button
                key={candidate}
                type="button"
                variant={runtime === candidate ? "default" : "outline"}
                size="sm"
                onClick={() => setRuntime(candidate)}
              >
                {candidate}
              </Button>
            ))}
            <Button
              type="submit"
              size="sm"
              className="ml-auto"
              disabled={isRunning || code.trim() === ""}
            >
              {isRunning ? "Running…" : "Run in sandbox"}
            </Button>
          </div>
          <textarea
            value={code}
            onChange={(event) => setCode(event.target.value)}
            placeholder={PLACEHOLDER[runtime]}
            spellCheck={false}
            rows={8}
            aria-label={`${runtime} source to run in the sandbox`}
            className="w-full rounded-md border border-border bg-card p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
          />
        </form>

        {error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {runs === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No runs yet. Each run boots a fresh, isolated Vercel Sandbox.
          </p>
        ) : (
          <ul className="space-y-3">
            {runs.map((run) => (
              <RunCard key={run.id} run={run} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "cloud-sandbox",
    title: "Cloud Sandbox",
    icon: "Zap",
    // Routed at /plugins/cloud-sandbox/cloud-sandbox.
    path: "cloud-sandbox",
    component: SandboxPage,
  });
});
