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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/** Background refresh cadence while the page is open. */
const POLL_MS = 45_000;

type SortKey = "name" | "createdAt" | "lastUsedAt";
type SortDirection = "asc" | "desc";
type StatusFilter = "all" | MachineView["state"];

const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "running", label: "Running" },
  { id: "connecting", label: "Connecting" },
  { id: "inactive", label: "Inactive" },
  { id: "error", label: "Error" },
];

/** Status colours are semantic, not theme accents, so they are literal hues. */
const DOT_STYLES: Record<MachineView["state"], string> = {
  running: "bg-emerald-500",
  connecting: "bg-amber-500",
  inactive: "bg-muted-foreground/40",
  error: "bg-destructive",
};

const STATE_STYLES: Record<MachineView["state"], string> = {
  running: "text-foreground",
  connecting: "text-muted-foreground",
  inactive: "text-muted-foreground",
  error: "text-destructive",
};

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

function StatusCell({ machine }: { machine: MachineView }) {
  return (
    <span
      className={cn("flex items-center gap-2 text-xs", STATE_STYLES[machine.state])}
    >
      {machine.state === "connecting" ? (
        <Spinner className="size-3" />
      ) : (
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", DOT_STYLES[machine.state])}
        />
      )}
      {machine.status}
    </span>
  );
}

/** Compact absolute timestamp; the full value is in the title attribute. */
function formatDate(ms: number | null): string {
  if (ms === null) return "—";
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function DateCell({ ms, hint }: { ms: number | null; hint?: string }) {
  const iso = ms === null ? undefined : new Date(ms).toISOString();
  return (
    <span
      className="text-xs text-muted-foreground"
      title={[iso, hint].filter(Boolean).join("\n") || undefined}
    >
      {formatDate(ms)}
    </span>
  );
}

function SortableHead({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: { key: SortKey; direction: SortDirection };
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className="flex items-center gap-1 font-medium hover:text-foreground"
        aria-sort={
          active
            ? sort.direction === "asc"
              ? "ascending"
              : "descending"
            : "none"
        }
      >
        {label}
        <span aria-hidden className={cn("text-xs", active ? "" : "opacity-0")}>
          {sort.direction === "asc" ? "\u2191" : "\u2193"}
        </span>
      </button>
    </TableHead>
  );
}

/**
 * Deleting removes the sandbox, its snapshots and the bb host registration, so
 * it asks first and spells out what goes.
 *
 * This uses Dialog rather than AlertDialog deliberately: bb's vendored Dialog
 * renders through ResponsiveDrawerShell, so it becomes a bottom drawer on
 * compact viewports. The registry's AlertDialog has no such treatment.
 */
/**
 * Every row action lives here. Actions that do not apply to the machine's
 * current state stay visible but disabled, so the menu reads the same way for
 * every row rather than shifting entries around.
 */
function MachineActions({
  machine,
  busy,
  onStop,
  onWake,
  onRemove,
}: {
  machine: MachineView;
  busy: boolean;
  onStop: () => void;
  onWake: () => void;
  onRemove: () => void;
}) {
  const isOff = machine.state === "inactive" || machine.state === "error";
  // A sandbox that failed or aborted has no session to resume.
  const canWake = machine.state === "inactive" && !machine.waking;
  const canStop = machine.state === "running" || machine.state === "connecting";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          aria-label={`Actions for ${machine.name}`}
        >
          {busy ? <Spinner className="size-3.5" /> : "\u22ef"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem disabled={!canWake} onSelect={onWake}>
          {machine.waking ? "Waking…" : "Wake up"}
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!canStop} onSelect={onStop}>
          Stop
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          disabled={machine.waking}
          onSelect={onRemove}
        >
          Delete
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function DeleteMachineDialog({
  machine,
  onCancel,
  onConfirm,
  busy,
}: {
  machine: MachineView | null;
  onCancel: () => void;
  onConfirm: () => void;
  busy: boolean;
}) {
  return (
    <Dialog
      open={machine !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete this cloud machine?</DialogTitle>
          <DialogDescription asChild>
            <div className="space-y-2">
              <p>
                <span className="font-mono">{machine?.name}</span> will be
                permanently deleted. This cannot be undone.
              </p>
              <ul className="list-disc space-y-0.5 pl-4">
                <li>The Vercel sandbox is deleted</li>
                <li>Its snapshots are deleted, so it can never be woken</li>
                <li>Its machine registration is removed from bb</li>
              </ul>
              <p>
                To keep the machine so it can be woken again later, cancel and
                use <span className="font-medium">Stop</span> instead.
              </p>
            </div>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {/* Cancel first so it takes initial focus, not the destructive action. */}
          <Button variant="outline" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            onClick={onConfirm}
            disabled={busy}
          >
            {busy ? "Deleting…" : "Delete machine"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const [confirming, setConfirming] = useState<MachineView | null>(null);
  const [vercelUrl, setVercelUrl] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>("all");
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: "createdAt",
    direction: "desc",
  });
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
          setVercelUrl(result.vercelUrl);
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

  const act = (
    method: "machines_stop" | "machines_remove" | "machines_wake",
    name: string,
  ) => {
    setBusyName(name);
    setError(null);
    rpc.call(method, { name }).then(
      () => {
        setBusyName(null);
        setConfirming(null);
        refetch();
      },
      (cause: unknown) => {
        setBusyName(null);
        // Keep the dialog open on failure so the error is not hidden behind it.
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const toggleSort = (key: SortKey) => {
    setSort((current) =>
      current.key === key
        ? { key, direction: current.direction === "asc" ? "desc" : "asc" }
        : // Names read naturally A-Z; dates read naturally newest first.
          { key, direction: key === "name" ? "asc" : "desc" },
    );
  };

  const visible = (machines ?? [])
    .filter((machine) => filter === "all" || machine.state === filter)
    .slice()
    .sort((left, right) => {
      const factor = sort.direction === "asc" ? 1 : -1;
      if (sort.key === "name") return factor * left.name.localeCompare(right.name);
      // A machine that never connected has no last-used time; sort it last
      // whichever way the column is pointing.
      const a = sort.key === "createdAt" ? left.createdAt : left.lastUsedAt;
      const b = sort.key === "createdAt" ? right.createdAt : right.lastUsedAt;
      if (a === null) return 1;
      if (b === null) return -1;
      return factor * (a - b);
    });

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" onClick={create} disabled={creating || !signedIn}>
            {creating ? (
              <Spinner className="mr-2" />
            ) : (
              <Icon name="Plus" className="mr-1.5 size-4" aria-hidden />
            )}
            {creating ? "Creating…" : "Create cloud machine"}
          </Button>
          {/* Internal bb route: UrlLink keeps it in SPA history. */}
          <UrlLink
            href="/settings/machines"
            className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            View BB connect machines
          </UrlLink>
          {vercelUrl === null ? null : (
            <UrlLink
              href={vercelUrl}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              View on Vercel
            </UrlLink>
          )}
          <Button
            variant="outline"
            size="sm"

            onClick={() => refetch(true)}
            disabled={refreshing}
          >
            <Icon
              name="RotateCcw"
              className={cn("mr-1.5 size-4", refreshing && "animate-spin")}
              aria-hidden
            />
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

        <div className="flex flex-wrap items-center gap-1">
          {STATUS_FILTERS.map((option) => {
            const count =
              option.id === "all"
                ? (machines ?? []).length
                : (machines ?? []).filter((m) => m.state === option.id).length;
            return (
              <Button
                key={option.id}
                variant={filter === option.id ? "default" : "outline"}
                size="sm"
                onClick={() => setFilter(option.id)}
              >
                {option.label}
                <span className="ml-1.5 opacity-60">{count}</span>
              </Button>
            );
          })}
        </div>

        {machines === null ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : machines.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No cloud machines yet. Each one is a Vercel Sandbox that joins bb as
            a machine you can run threads on.
          </p>
        ) : (
          // Capped height with its own scroll so a long list cannot push the
          // debug log off the page.
          <div className="max-h-[26rem] overflow-auto rounded-lg border border-border">
            <Table>
              <TableHeader className="sticky top-0 z-10 [&_th]:bg-card">
                <TableRow>
                  <SortableHead
                    label="Machine"
                    column="name"
                    sort={sort}
                    onSort={toggleSort}
                  />
                  <TableHead>Status</TableHead>
                  <SortableHead
                    label="Created"
                    column="createdAt"
                    sort={sort}
                    onSort={toggleSort}
                  />
                  <SortableHead
                    label="Last used"
                    column="lastUsedAt"
                    sort={sort}
                    onSort={toggleSort}
                  />
                  <TableHead className="text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={5}
                      className="text-center text-xs text-muted-foreground"
                    >
                      No machines with that status.
                    </TableCell>
                  </TableRow>
                ) : (
                  visible.map((machine) => {
                    const busy = busyName === machine.name;
                    return (
                      <TableRow key={machine.name}>
                        <TableCell className="max-w-[16rem]">
                          <p className="truncate text-sm font-medium">
                            {machine.name}
                          </p>
                          {machine.hostId !== null ? (
                            <p className="truncate font-mono text-xs text-muted-foreground">
                              {machine.hostId}
                              {machine.hostName === null
                                ? null
                                : ` · ${machine.hostName}`}
                            </p>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <StatusCell machine={machine} />
                        </TableCell>
                        <TableCell>
                          <DateCell
                            ms={machine.createdAt}
                            hint={
                              machine.sessionStartedAt === null
                                ? undefined
                                : `Current session started ${new Date(machine.sessionStartedAt).toISOString()}`
                            }
                          />
                        </TableCell>
                        <TableCell>
                          <DateCell ms={machine.lastUsedAt} />
                        </TableCell>
                        <TableCell className="text-right">
                          <MachineActions
                            machine={machine}
                            busy={busy}
                            onStop={() => act("machines_stop", machine.name)}
                            onWake={() => act("machines_wake", machine.name)}
                            onRemove={() => setConfirming(machine)}
                          />
                        </TableCell>
                      </TableRow>
                    );
                  })
                )}
              </TableBody>
            </Table>
          </div>
        )}

        <DebugLog />
      </div>

      <DeleteMachineDialog
        machine={confirming}
        busy={confirming !== null && busyName === confirming.name}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          if (confirming !== null) act("machines_remove", confirming.name);
        }}
      />
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
