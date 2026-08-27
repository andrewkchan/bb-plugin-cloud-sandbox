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
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  UrlLink,
} from "@get-bb/plugin-sdk/app";
import type { AuthStatus, rpcContract, RunRecord } from "./server";
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
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("runs_list").then((result) => setRuns(result.runs), report);
    rpc
      .call("auth_status")
      .then((result) => setSignedIn(result.state === "signed-in"), report);
  }, [rpc, report]);

  useEffect(refetch, [refetch]);
  // server.ts publishes after every run — from this page, another window, or
  // `bb cloud-sandbox run` invoked by an agent — so the list never goes stale.
  useRealtime("runs-changed", refetch);
  useRealtime("auth-changed", refetch);

  return { rpc, runs, signedIn, error, setError, report, refetch };
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
  const { rpc, runs, signedIn, error, setError, report, refetch } = useSandbox();
  const clearHistory = () => {
    rpc.call("runs_clear").then(refetch, report);
  };
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
        {signedIn === false ? (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Not signed in to Vercel.</p>
            <p className="mt-1 text-muted-foreground">
              Use <span className="font-medium">Sign in with Vercel</span> on
              this plugin&apos;s settings page to connect your account.
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
          <>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {runs.length} recent {runs.length === 1 ? "run" : "runs"}
              </p>
              <Button variant="outline" size="sm" onClick={clearHistory}>
                Clear history
              </Button>
            </div>
            <ul className="space-y-3">
              {runs.map((run) => (
                <RunCard key={run.id} run={run} />
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}


/** The "Sign in with Vercel" flow, rendered on the plugin's settings page. */
function VercelAuthSection() {
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setBusy(false);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("auth_status").then(setStatus, report);
  }, [rpc, report]);

  useEffect(refetch, [refetch]);
  useRealtime("auth-changed", refetch);

  // The device flow completes in a browser tab the plugin cannot observe, so
  // poll while it is outstanding. The realtime signal above usually wins; this
  // is the fallback when it does not arrive.
  useEffect(() => {
    if (status?.state !== "pending") return;
    const timer = setInterval(refetch, 2500);
    return () => clearInterval(timer);
  }, [status?.state, refetch]);

  const start = () => {
    setBusy(true);
    setError(null);
    rpc.call("auth_start").then((next) => {
      setBusy(false);
      setStatus(next);
      // Open the approval page for the user rather than making them copy a URL.
      if (next.verificationUriComplete !== null) {
        navigate.openUrl(next.verificationUriComplete);
      }
    }, report);
  };

  const signOut = () => {
    setBusy(true);
    setError(null);
    rpc.call("auth_sign_out").then((next) => {
      setBusy(false);
      setStatus(next);
    }, report);
  };

  const cancel = () => {
    rpc.call("auth_cancel").then(setStatus, report);
  };

  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (status.state === "signed-in") {
    return (
      <div className="space-y-2 text-sm">
        <p>
          Signed in to Vercel — team{" "}
          <span className="font-medium">{status.teamSlug ?? "unknown"}</span>,
          project{" "}
          <span className="font-medium">{status.projectSlug ?? "unknown"}</span>
          .
        </p>
        <Button variant="outline" size="sm" onClick={signOut} disabled={busy}>
          Sign out
        </Button>
      </div>
    );
  }

  if (status.state === "pending") {
    return (
      <div className="space-y-2 text-sm">
        <p>Waiting for you to approve the sign-in in your browser…</p>
        <p className="text-muted-foreground">
          If the page did not open,{" "}
          <UrlLink
            href={status.verificationUriComplete ?? "https://vercel.com"}
            className="underline"
          >
            open it here
          </UrlLink>
          . Confirmation code:{" "}
          <code className="font-mono">{status.userCode}</code>
        </p>
        <Button variant="outline" size="sm" onClick={cancel}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        Connect a Vercel account to run code in a sandbox. Your Vercel team and
        project are detected automatically — a project is created for you if you
        do not have one.
      </p>
      {error !== null || status.error !== null ? (
        <p className="text-destructive">{error ?? status.error}</p>
      ) : null}
      <Button size="sm" onClick={start} disabled={busy}>
        {busy ? "Starting…" : "Sign in with Vercel"}
      </Button>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "vercel-auth",
    title: "Vercel account",
    description:
      "Cloud Sandbox runs code on Vercel. Sign in once; the session refreshes itself.",
    component: VercelAuthSection,
  });
  app.slots.navPanel({
    id: "cloud-sandbox",
    title: "Cloud Sandbox",
    icon: "Zap",
    // Routed at /plugins/cloud-sandbox/cloud-sandbox.
    path: "cloud-sandbox",
    component: SandboxPage,
  });
});
