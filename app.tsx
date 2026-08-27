// bb-plugin-cloud-sandbox — frontend entry.
//
// Compiled by `bb plugin build` into dist/app.js + dist/app.css. React and
// @get-bb/plugin-sdk/app are provided by the BB app at load time.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useRealtime,
  useRpc,
  UrlLink,
} from "@get-bb/plugin-sdk/app";
import type { AuthStatus, DebugEvent, MachineView, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Background refresh cadence while the page is open. */
const POLL_MS = 45_000;

function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-block size-3.5 animate-spin rounded-full border-2 border-current border-t-transparent",
        className,
      )}
    />
  );
}

const STATE_STYLES: Record<MachineView["state"], string> = {
  running: "text-foreground",
  connecting: "text-muted-foreground",
  inactive: "text-muted-foreground",
  error: "text-destructive",
};

function MachineRow({
  machine,
  onDelete,
  busy,
}: {
  machine: MachineView;
  onDelete: () => void;
  busy: boolean;
}) {
  return (
    <li className="flex items-center gap-3 rounded-lg border border-border p-3">
      <div className="min-w-0 flex-1">
        {/* The sandbox name is the one identifier this plugin owns. bb's host
            name is the container's hostname, which a resumed sandbox may not
            keep, so it is not the title. */}
        <p className="truncate text-sm font-medium">{machine.name}</p>
        <p
          className={cn(
            "mt-0.5 flex items-center gap-1.5 text-xs",
            STATE_STYLES[machine.state],
          )}
        >
          {machine.state === "connecting" ? <Spinner /> : null}
          {machine.status}
        </p>
        {machine.hostId !== null ? (
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {machine.hostId}
            {machine.hostName === null ? null : ` · ${machine.hostName}`}
          </p>
        ) : null}
      </div>
      <Button variant="outline" size="sm" onClick={onDelete} disabled={busy}>
        {machine.state === "inactive" || machine.state === "error"
          ? "Remove"
          : "Stop"}
      </Button>
    </li>
  );
}

function DebugLog() {
  const rpc = useRpc<typeof rpcContract>();
  const [open, setOpen] = useState(false);
  const [events, setEvents] = useState<DebugEvent[] | null>(null);

  useEffect(() => {
    if (!open) return;
    rpc.call("events_list").then(
      (result) => setEvents(result.events),
      () => setEvents([]),
    );
  }, [open, rpc]);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((current) => !current)}
        className="flex w-full items-center justify-between p-3 text-left text-sm font-medium"
      >
        Debug log
        <span className="text-xs text-muted-foreground">
          {open ? "Hide" : "Show"}
        </span>
      </button>
      {open ? (
        <div className="border-t border-border p-3">
          {events === null ? (
            <p className="text-xs text-muted-foreground">Loading…</p>
          ) : events.length === 0 ? (
            <p className="text-xs text-muted-foreground">No events recorded.</p>
          ) : (
            <ul className="space-y-1.5">
              {events.map((event) => (
                <li key={event.id} className="font-mono text-xs">
                  <span className="text-muted-foreground">{event.at}</span>{" "}
                  <span className="font-medium">{event.kind}</span>
                  {event.machine === null ? null : (
                    <span className="text-muted-foreground">
                      {" "}
                      {event.machine}
                    </span>
                  )}
                  <span className="text-muted-foreground"> — {event.detail}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function MachinesPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<MachineView[] | null>(null);
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);

  const refetch = useCallback(
    (manual = false) => {
      // A slow list must not stack up behind the interval timer.
      if (inFlight.current) return;
      inFlight.current = true;
      if (manual) setRefreshing(true);
      rpc.call("machines_list").then(
        (result) => {
          inFlight.current = false;
          setRefreshing(false);
          setMachines(result.machines);
          setSignedIn(result.signedIn);
          setCreating(result.creating);
          setError(null);
        },
        (cause: unknown) => {
          inFlight.current = false;
          setRefreshing(false);
          setError(cause instanceof Error ? cause.message : String(cause));
        },
      );
    },
    [rpc],
  );

  useEffect(() => {
    refetch();
  }, [refetch]);

  // Only while the page is mounted; the interval is cleared on unmount.
  useEffect(() => {
    const timer = setInterval(() => refetch(), POLL_MS);
    return () => clearInterval(timer);
  }, [refetch]);

  // Creation and disconnect detection both publish, so the list reacts
  // immediately rather than waiting out the poll interval.
  useRealtime("machines-changed", () => refetch());

  const create = () => {
    setCreating(true);
    setError(null);
    rpc.call("machines_create").then(
      () => refetch(),
      (cause: unknown) => {
        setCreating(false);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const remove = (name: string) => {
    setBusyName(name);
    rpc.call("machines_delete", { name }).then(
      () => {
        setBusyName(null);
        refetch();
      },
      (cause: unknown) => {
        setBusyName(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={create} disabled={creating || !signedIn}>
            {creating ? (
              <>
                <Spinner className="mr-2" />
                Creating…
              </>
            ) : (
              "Create cloud machine"
            )}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => refetch(true)}
            disabled={refreshing}
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        </div>

        {signedIn === false ? (
          <div className="rounded-lg border border-border p-3 text-sm">
            <p className="font-medium">Not signed in to Vercel.</p>
            <p className="mt-1 text-muted-foreground">
              Use <span className="font-medium">Sign in with Vercel</span> on
              this plugin&apos;s settings page to connect your account.
            </p>
          </div>
        ) : null}

        {error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {machines === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cloud machines yet. Each one is a Vercel Sandbox that joins bb as
            a machine you can run threads on.
          </p>
        ) : (
          <ul className="space-y-2">
            {machines.map((machine) => (
              <MachineRow
                key={machine.name}
                machine={machine}
                busy={busyName === machine.name}
                onDelete={() => remove(machine.name)}
              />
            ))}
          </ul>
        )}

        <DebugLog />
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
  // poll while it is outstanding.
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

  if (status === null) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }

  if (status.state === "signed-in") {
    return (
      <div className="space-y-2 text-sm">
        <p>
          Signed in to Vercel — team{" "}
          <span className="font-medium">{status.teamSlug ?? "unknown"}</span>.
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
        <Button
          variant="outline"
          size="sm"
          onClick={() => rpc.call("auth_cancel").then(setStatus, report)}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-2 text-sm">
      <p className="text-muted-foreground">
        Connect a Vercel account to create cloud machines. Your Vercel team and
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
      "Cloud machines run on Vercel. Sign in once; the session refreshes itself.",
    component: VercelAuthSection,
  });
  app.slots.navPanel({
    id: "cloud-machines",
    title: "Cloud Machines",
    icon: "Cloud",
    path: "cloud-machines",
    component: MachinesPage,
  });
});
