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
import type {
  AuthStatus,
  DebugEvent,
  MachineView,
  PluginBuild,
  PluginTemplate,
  rpcContract,
} from "./server";
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
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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

/**
 * The last machine list seen in this window.
 *
 * A nav panel unmounts when you navigate away, so component state cannot
 * survive a revisit. Holding it here lets the page paint its previous contents
 * immediately and refresh behind them instead of showing "Loading…" again.
 */
let lastMachineSnapshot: {
  machines: MachineView[];
  readyTemplates: { id: string; name: string }[];
  defaultTemplateId: string | null;
  vercelUrl: string | null;
  signedIn: boolean;
} | null = null;

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
  const [machines, setMachines] = useState<MachineView[] | null>(
    () => lastMachineSnapshot?.machines ?? null,
  );
  const [signedIn, setSignedIn] = useState<boolean | null>(
    () => lastMachineSnapshot?.signedIn ?? null,
  );
  /** True while the server is refreshing a stale answer behind this one. */
  const [refreshingInBackground, setRefreshingInBackground] = useState(false);
  const [creating, setCreating] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [busyName, setBusyName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MachineView | null>(null);
  const [vercelUrl, setVercelUrl] = useState<string | null>(
    () => lastMachineSnapshot?.vercelUrl ?? null,
  );
  const [readyTemplates, setReadyTemplates] = useState<{ id: string; name: string }[]>(
    () => lastMachineSnapshot?.readyTemplates ?? [],
  );
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(
    () => lastMachineSnapshot?.defaultTemplateId ?? null,
  );
  // The chevron picks which image the button will use; it does not create.
  // Until the user picks, the selection follows the server's default so a
  // refresh cannot silently change what the button would do.
  const [lastFailure, setLastFailure] = useState<{
    action: "create" | "wake";
    message: string;
    status: number | null;
    at: number;
  } | null>(null);
  const [pickedTemplateId, setPickedTemplateId] = useState<string | null>(null);
  const [hasPicked, setHasPicked] = useState(false);
  const selectedTemplateId = hasPicked ? pickedTemplateId : defaultTemplateId;
  const selectedTemplateName =
    selectedTemplateId === null
      ? "no image"
      : (readyTemplates.find((image) => image.id === selectedTemplateId)?.name ??
        "no image");
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
      rpc.call("machines_list", { force: manual }).then(
        (result) => {
          inFlight.current = false;
          setRefreshing(false);
          setMachines(result.machines);
          setSignedIn(result.signedIn);
          setCreating(result.creating);
          setVercelUrl(result.vercelUrl);
          setReadyTemplates(result.readyTemplates);
          setDefaultTemplateId(result.defaultTemplateId);
          setLastFailure(result.lastFailure);
          setRefreshingInBackground(result.refreshing);
          lastMachineSnapshot = {
            machines: result.machines,
            readyTemplates: result.readyTemplates,
            defaultTemplateId: result.defaultTemplateId,
            vercelUrl: result.vercelUrl,
            signedIn: result.signedIn,
          };
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

  const create = (templateId: string | null) => {
    setCreating(true);
    setError(null);
    rpc.call("machines_create", { templateId }).then(
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

  if (signedIn === false) {
    return (
      <div className="h-full overflow-auto p-4 md:p-5">
        <div className="mx-auto w-full max-w-4xl">
          <div className="rounded-lg border border-border p-4 text-sm">
            <p className="font-medium">Not signed in to Vercel.</p>
            <p className="mt-1 text-muted-foreground">
              Cloud machines run on Vercel Sandboxes. Connect an account to
              create one.
            </p>
            <Button size="sm" className="mt-3" asChild>
              <UrlLink href={SETTINGS_AUTH_HREF}>
                Sign in with Vercel
                <Icon
                  name="ExternalLink"
                  className="ml-1.5 size-3.5 opacity-60"
                  aria-hidden
                />
              </UrlLink>
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4 md:p-5">
      <div className="mx-auto w-full max-w-4xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center">
            <Button
              size="sm"
              className="rounded-r-none"
              onClick={() => create(selectedTemplateId)}
              disabled={creating || !signedIn}
            >
              {creating ? (
                <Spinner className="mr-2" />
              ) : (
                <Icon name="Plus" className="mr-1.5 size-4" aria-hidden />
              )}
              {creating
                ? "Creating\u2026"
                : `Create cloud machine (${selectedTemplateName})`}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="sm"
                  className="rounded-l-none border-l border-background/30 px-2"
                  disabled={creating || !signedIn}
                  aria-label={`Change template, currently ${selectedTemplateName}`}
                >
                  {"\u25be"}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {/* A radio group, not a list of actions: choosing an entry
                    only changes what the button will do. */}
                <DropdownMenuRadioGroup
                  value={selectedTemplateId ?? ""}
                  onValueChange={(value) => {
                    setPickedTemplateId(value === "" ? null : value);
                    setHasPicked(true);
                  }}
                >
                  {readyTemplates.map((image) => (
                    <DropdownMenuRadioItem key={image.id} value={image.id}>
                      {image.name}
                    </DropdownMenuRadioItem>
                  ))}
                  {readyTemplates.length === 0 ? null : <DropdownMenuSeparator />}
                  <DropdownMenuRadioItem value="">
                    No template (Vercel default)
                  </DropdownMenuRadioItem>
                </DropdownMenuRadioGroup>
                <DropdownMenuSeparator />
                {/* Sits outside the radio group: this navigates away rather
                    than changing the selection, and the icon says so. */}
                <DropdownMenuItem asChild>
                  <UrlLink href={SETTINGS_TEMPLATES_HREF}>
                    Configure templates
                    <Icon
                      name="ExternalLink"
                      className="ml-auto size-3.5 opacity-60"
                      aria-hidden
                    />
                  </UrlLink>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
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
          {/* Subtle: the list on screen is usable, it is just not the newest. */}
          {refreshingInBackground && !refreshing ? (
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              Refreshing
            </span>
          ) : null}
        </div>

        {error !== null ? (
          <p className="text-sm text-destructive">{error}</p>
        ) : null}

        {lastFailure !== null ? (
          <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">
              {lastFailure.action === "create"
                ? "Could not create a cloud machine"
                : "Could not wake a cloud machine"}
              {lastFailure.status === null ? null : ` (${lastFailure.status})`}
            </p>
            <p className="mt-1 text-muted-foreground">{lastFailure.message}</p>
            <div className="mt-2 flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  rpc.call("machines_dismiss_failure").then(
                    () => setLastFailure(null),
                    (cause: unknown) =>
                      setError(
                        cause instanceof Error ? cause.message : String(cause),
                      ),
                  )
                }
              >
                Dismiss
              </Button>
              {vercelUrl === null ? null : (
                <UrlLink
                  href={vercelUrl}
                  className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
                >
                  Manage on Vercel
                </UrlLink>
              )}
            </div>
          </div>
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
            No cloud machines yet. Each one is a Vercel Sandbox that installs
            bb and joins as a machine you can run threads on.
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
                  <TableHead>Template</TableHead>
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
                      colSpan={6}
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
                              {/* The host id is bb's own identity for this
                                  machine, so it links to bb's page for it.
                                  Present whenever the machine is still
                                  enrolled, including while it is stopped. */}
                              <UrlLink
                                href={bbMachineHref(machine.hostId)}
                                className="underline underline-offset-2 hover:text-foreground"
                              >
                                {machine.hostId}
                              </UrlLink>
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
                          <span className="text-xs text-muted-foreground">
                            {machine.templateName ?? "—"}
                          </span>
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


/** Ready is the expected state and carries no dot; the rest need attention. */
const TEMPLATE_STATUS_STYLES: Record<
  Exclude<PluginTemplate["status"], "ready" | "building">,
  string
> = {
  pending: "bg-muted-foreground/40",
  error: "bg-destructive",
};

const TEMPLATE_STATUS_LABELS: Record<PluginTemplate["status"], string> = {
  ready: "Ready",
  building: "Building",
  pending: "Pending",
  error: "Error",
};

function TemplateStatus({ status }: { status: PluginTemplate["status"] }) {
  return (
    <span className="flex items-center gap-2 text-xs text-muted-foreground">
      {status === "building" ? <Spinner className="size-3" /> : null}
      {status === "pending" || status === "error" ? (
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", TEMPLATE_STATUS_STYLES[status])}
        />
      ) : null}
      {TEMPLATE_STATUS_LABELS[status]}
    </span>
  );
}

/** One build's captured log, fetched on demand. */
function BuildLog({ build, onBack }: { build: PluginBuild; onBack: () => void }) {
  const rpc = useRpc<typeof rpcContract>();
  const [log, setLog] = useState<string | null>(null);

  const refetch = useCallback(() => {
    rpc.call("build_log", { id: build.id }).then(
      (r) => setLog(r.log),
      () => setLog(""),
    );
  }, [rpc, build.id]);

  useEffect(refetch, [refetch]);
  // A running build appends to its log as it goes.
  useRealtime("templates-changed", () => {
    if (build.status === "building") refetch();
  });

  return (
    <div className="space-y-2">
      <Button variant="outline" size="sm" onClick={onBack}>
        Back to builds
      </Button>
      <p className="text-xs text-muted-foreground">
        Build {build.id} · {TEMPLATE_STATUS_LABELS[build.status === "ready" ? "ready" : build.status === "error" ? "error" : "building"]}
        {build.error === null ? null : ` · ${build.error}`}
      </p>
      <pre className="max-h-[28rem] overflow-auto rounded-md border border-border bg-card p-2 font-mono text-xs whitespace-pre-wrap">
        {log === null ? "Loading…" : log === "" ? "No output." : log}
      </pre>
    </div>
  );
}

/**
 * Credentials a template injects when a machine is created, by provider.
 *
 * Deliberately separate from the build-time variables above: those are baked
 * into the image and readable by anyone who can pull it, while these never
 * enter a layer. Write-only from here — the backend reports which keys are
 * set and never returns a value.
 */
function TemplateSecrets({ templateId }: { templateId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [providers, setProviders] = useState<
    {
      id: string;
      label: string;
      description: string;
      hint: string;
      credentials: { key: string; label: string }[];
    }[]
  >([]);
  const [keys, setKeys] = useState<string[] | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setBusyKey(null);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  useEffect(() => {
    rpc.call("agent_providers").then((r) => setProviders(r.providers), report);
  }, [rpc, report]);

  useEffect(() => {
    rpc
      .call("templates_secret_keys", { templateId })
      .then((r) => setKeys(r.keys), report);
  }, [rpc, templateId, report]);

  const save = (key: string, value: string) => {
    setBusyKey(key);
    setError(null);
    rpc
      .call("templates_set_secret", { templateId, key, value })
      .then((r) => {
        setBusyKey(null);
        setKeys(r.keys);
        setDrafts((current) => ({ ...current, [key]: "" }));
      }, report);
  };

  const isSet = (key: string) => keys?.includes(key) ?? false;
  const configuredCount = (provider: (typeof providers)[number]) =>
    provider.credentials.filter((c) => isSet(c.key)).length;

  const open = providers.find((provider) => provider.id === openId) ?? null;

  if (open !== null) {
    return (
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpenId(null)}>
            Back to agents
          </Button>
          <span className="text-xs font-medium">{open.label}</span>
        </div>
        <p className="text-xs text-muted-foreground">{open.hint}</p>
        <ul className="space-y-2">
          {open.credentials.map((credential) => (
            <li key={credential.key} className="flex flex-wrap items-center gap-2">
              <span className="w-40 shrink-0 text-xs">
                {credential.label}
                {isSet(credential.key) ? (
                  <span className="ml-1.5 text-emerald-600 dark:text-emerald-500">
                    ✓
                  </span>
                ) : null}
              </span>
              <Input
                type="password"
                value={drafts[credential.key] ?? ""}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [credential.key]: event.target.value,
                  }))
                }
                placeholder={
                  isSet(credential.key) ? "Replace the stored value" : credential.key
                }
                className="max-w-xs font-mono"
                autoComplete="off"
                aria-label={`${open.label} ${credential.label}`}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => save(credential.key, drafts[credential.key] ?? "")}
                disabled={
                  busyKey === credential.key ||
                  (drafts[credential.key] ?? "").trim() === ""
                }
              >
                {busyKey === credential.key ? "Saving…" : "Save"}
              </Button>
              {isSet(credential.key) ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => save(credential.key, "")}
                  disabled={busyKey === credential.key}
                >
                  Clear
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
        {error !== null ? <p className="text-destructive">{error}</p> : null}
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <label className="text-xs font-medium">Agent credentials</label>
      <p className="text-xs text-muted-foreground">
        Credentials injected into a machine&apos;s environment when it is created.
      </p>
      <ul className="space-y-2">
        {providers.map((provider) => {
          const count = configuredCount(provider);
          return (
            <li key={provider.id}>
              <button
                type="button"
                onClick={() => setOpenId(provider.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border p-2.5 text-left hover:bg-card"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">
                    {provider.label}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {provider.description}
                  </span>
                </span>
                {count > 0 ? (
                  <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <span
                      aria-hidden
                      className="size-2 shrink-0 rounded-full bg-emerald-500"
                    />
                    Configured
                    {provider.credentials.length > 1 ? ` (${count})` : ""}
                  </span>
                ) : (
                  <span className="text-xs text-muted-foreground">Not set</span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      {error !== null ? <p className="text-destructive">{error}</p> : null}
    </div>
  );
}

/** A template's configuration, its Build button, and its build history. */
function TemplateDetail({
  template,
  registryUrl,
  onBack,
  onDeleted,
}: {
  template: PluginTemplate;
  registryUrl: string | null;
  onBack: () => void;
  onDeleted: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [name, setName] = useState(template.name);
  const [commands, setCommands] = useState(template.commands);
  const [env, setEnv] = useState<{ key: string; value: string }[]>(template.env);
  const [builds, setBuilds] = useState<PluginBuild[] | null>(null);
  const [openBuild, setOpenBuild] = useState<PluginBuild | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const report = useCallback((cause: unknown) => {
    setBusy(false);
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetchBuilds = useCallback(() => {
    rpc.call("builds_list", { templateId: template.id }).then(
      (r) => setBuilds(r.builds),
      report,
    );
  }, [rpc, template.id, report]);

  useEffect(refetchBuilds, [refetchBuilds]);
  useRealtime("templates-changed", refetchBuilds);

  const save = () => {
    setBusy(true);
    setError(null);
    rpc
      .call("templates_update", { id: template.id, name, commands, env })
      .then(() => {
        setBusy(false);
        setSaved(true);
      }, report);
  };

  const build = () => {
    setBusy(true);
    setError(null);
    // Save first: building the previous configuration would be surprising.
    rpc
      .call("templates_update", { id: template.id, name, commands, env })
      .then(() => rpc.call("templates_build", { id: template.id }))
      .then(() => {
        setBusy(false);
        refetchBuilds();
      }, report);
  };

  if (openBuild !== null) {
    return <BuildLog build={openBuild} onBack={() => setOpenBuild(null)} />;
  }

  return (
    <div className="space-y-4 text-sm">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onBack}>
          Back to templates
        </Button>
        <TemplateStatus status={template.status} />
        {registryUrl === null ? null : (
          <UrlLink
            href={registryUrl}
            className="ml-auto flex items-center gap-1 text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          >
            Manage images on Vercel
            <Icon name="ExternalLink" className="size-3.5 opacity-60" aria-hidden />
          </UrlLink>
        )}
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor="image-name">
          Name
        </label>
        <Input
          id="image-name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setSaved(false);
          }}
          className="max-w-sm"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium" htmlFor="image-commands">
          Custom commands
        </label>
        <p className="text-xs text-muted-foreground">
          Shell run after bb&apos;s prerequisites are installed. One command per
          line; a failing line fails the build.
        </p>
        <textarea
          id="image-commands"
          value={commands}
          onChange={(event) => {
            setCommands(event.target.value);
            setSaved(false);
          }}
          rows={8}
          spellCheck={false}
          placeholder="npm install -g @anthropic-ai/claude-code"
          className="w-full rounded-md border border-border bg-card p-2 font-mono text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>

      <div className="space-y-1.5">
        <label className="text-xs font-medium">Environment variables</label>
        <p className="text-xs text-muted-foreground">
          Named values baked into the image.
        </p>
        {env.map((entry, index) => (
          <div key={index} className="flex items-center gap-2">
            <Input
              value={entry.key}
              placeholder="NAME"
              className="max-w-[12rem] font-mono"
              onChange={(event) => {
                const next = [...env];
                next[index] = { ...entry, key: event.target.value };
                setEnv(next);
                setSaved(false);
              }}
            />
            <Input
              value={entry.value}
              placeholder="value"
              className="font-mono"
              onChange={(event) => {
                const next = [...env];
                next[index] = { ...entry, value: event.target.value };
                setEnv(next);
                setSaved(false);
              }}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setEnv(env.filter((_, i) => i !== index));
                setSaved(false);
              }}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          onClick={() => setEnv([...env, { key: "", value: "" }])}
        >
          Add variable
        </Button>
      </div>

      <TemplateSecrets templateId={template.id} />

      {error !== null ? <p className="text-destructive">{error}</p> : null}

      {/* Why the last build failed. Without this the list just says "Error". */}
      {template.status === "error" && template.lastError !== null ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3">
          <p className="font-medium text-destructive">Last build failed</p>
          <p className="mt-1 text-muted-foreground">{template.lastError}</p>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={build} disabled={busy || template.status === "building"}>
          {template.status === "building" ? "Building…" : "Build"}
        </Button>
        <Button variant="outline" size="sm" onClick={save} disabled={busy}>
          {saved ? "Saved" : "Save"}
        </Button>
        {template.imageRef === null ? null : (
          <span className="font-mono text-xs text-muted-foreground">
            {template.imageRef}
          </span>
        )}
        {/* Deleting drops the image and its build history from bb. The pushed
            tag stays in the registry, which "Manage images on Vercel" reaches. */}
        <Button
          variant="destructive"
          size="sm"
          className="ml-auto"
          onClick={() => {
            if (!confirmingDelete) {
              setConfirmingDelete(true);
              return;
            }
            setBusy(true);
            rpc.call("templates_delete", { id: template.id }).then(onDeleted, report);
          }}
          disabled={busy}
        >
          {confirmingDelete ? "Confirm delete" : "Delete template"}
        </Button>
      </div>

      <div className="space-y-1.5">
        <p className="text-xs font-medium">Builds</p>
        {builds === null ? (
          <p className="text-xs text-muted-foreground">Loading…</p>
        ) : builds.length === 0 ? (
          <p className="text-xs text-muted-foreground">No builds yet.</p>
        ) : (
          <ul className="space-y-1">
            {builds.map((entry) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setOpenBuild(entry)}
                  className="flex w-full items-center gap-3 rounded-md border border-border p-2 text-left text-xs hover:bg-card"
                >
                  <span className="font-mono">{entry.id}</span>
                  <span
                    className={cn(
                      entry.status === "error" && "text-destructive",
                      entry.status === "ready" && "text-foreground",
                      entry.status === "building" && "text-muted-foreground",
                    )}
                  >
                    {entry.status}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(entry.startedAt).toLocaleString()}
                  </span>
                  <span className="ml-auto text-muted-foreground">View log</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function TemplatesTab() {
  const rpc = useRpc<typeof rpcContract>();
  const [templates, setTemplates] = useState<PluginTemplate[] | null>(null);
  const [registryUrl, setRegistryUrl] = useState<string | null>(null);
  const [presets, setPresets] = useState<
    { id: string; label: string; description: string }[]
  >([]);
  const [openId, setOpenId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const report = useCallback((cause: unknown) => {
    setError(cause instanceof Error ? cause.message : String(cause));
  }, []);

  const refetch = useCallback(() => {
    rpc.call("templates_list").then((r) => {
      setTemplates(r.templates);
      setRegistryUrl(r.registryUrl);
      setPresets(r.presets);
    }, report);
  }, [rpc, report]);

  useEffect(refetch, [refetch]);
  useRealtime("templates-changed", refetch);

  const createFrom = (presetId: string) => {
    rpc.call("templates_create", { presetId }).then((created) => {
      refetch();
      setOpenId(created.id);
    }, report);
  };

  const open = templates?.find((entry) => entry.id === openId) ?? null;
  if (open !== null) {
    return (
      <TemplateDetail
        template={open}
        registryUrl={registryUrl}
        onBack={() => setOpenId(null)}
        onDeleted={() => {
          setOpenId(null);
          refetch();
        }}
      />
    );
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center">
        <Button
          size="sm"
          className="rounded-r-none"
          onClick={() => createFrom("blank")}
        >
          <Icon name="Plus" className="mr-1.5 size-4" aria-hidden />
          Create template
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              className="rounded-l-none border-l border-background/30 px-2"
              aria-label="Create template from a preset"
            >
              {"\u25be"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {/* Each entry creates immediately: this is an action menu, unlike
                the machine page's image picker, which only changes a choice. */}
            {presets.map((preset) => (
              <DropdownMenuItem
                key={preset.id}
                onSelect={() => createFrom(preset.id)}
              >
                <span className="flex flex-col">
                  <span>{preset.label}</span>
                  <span className="text-xs text-muted-foreground">
                    {preset.description}
                  </span>
                </span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error !== null ? <p className="text-destructive">{error}</p> : null}

      {templates === null ? (
        <p className="text-muted-foreground">Loading…</p>
      ) : templates.length === 0 ? (
        <p className="text-muted-foreground">
          No templates yet. A template bakes bb&apos;s prerequisites and your own
          setup commands into an image, and carries the credentials its
          machines are given.
        </p>
      ) : (
        <ul className="space-y-2">
          {templates.map((entry) => (
            <li key={entry.id}>
              <button
                type="button"
                onClick={() => setOpenId(entry.id)}
                className="flex w-full items-center gap-3 rounded-lg border border-border p-3 text-left hover:bg-card"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{entry.name}</span>
                  <span className="block truncate font-mono text-xs text-muted-foreground">
                    {entry.imageRef ?? "not built yet"}
                  </span>
                </span>
                <TemplateStatus status={entry.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
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

/**
 * Routes into this plugin's settings page. The tab is component state, so a
 * deep link carries it in the hash.
 */
export const SETTINGS_TEMPLATES_HREF =
  "/settings/plugins/cloud-sandbox#templates";
export const SETTINGS_AUTH_HREF =
  "/settings/plugins/cloud-sandbox#authentication";

/**
 * BB's own detail page for one enrolled machine, matching
 * SETTINGS_MACHINE_ROUTE_PATH ("/settings/machines/:hostId").
 */
function bbMachineHref(hostId: string): string {
  return `/settings/machines/${encodeURIComponent(hostId)}`;
}

const SETTINGS_TABS = ["templates", "authentication"] as const;

function CloudSandboxSettings() {
  // The tab is component state, so a deep link has to carry it in the hash.
  const [tab, setTab] = useState(() => {
    const hash =
      typeof window === "undefined" ? "" : window.location.hash.replace("#", "");
    return (SETTINGS_TABS as readonly string[]).includes(hash) ? hash : "templates";
  });

  // The hash is read on mount, which covers arriving from another page. This
  // also handles a link followed while the settings page is already open,
  // where the component does not remount.
  useEffect(() => {
    const onHashChange = () => {
      const hash = window.location.hash.replace("#", "");
      if ((SETTINGS_TABS as readonly string[]).includes(hash)) setTab(hash);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  return (
    <Tabs value={tab} onValueChange={setTab}>
      <TabsList>
        <TabsTrigger value="templates">Templates</TabsTrigger>
        <TabsTrigger value="authentication">Authentication</TabsTrigger>
      </TabsList>
      <TabsContent value="templates" className="pt-4">
        <TemplatesTab />
      </TabsContent>
      <TabsContent value="authentication" className="pt-4">
        <VercelAuthSection />
      </TabsContent>
    </Tabs>
  );
}

export default definePluginApp((app) => {
  app.slots.settingsSection({
    id: "cloud-sandbox-settings",
    component: CloudSandboxSettings,
  });
  app.slots.navPanel({
    id: "cloud-machines",
    title: "Cloud Machines",
    icon: "Cloud",
    path: "cloud-machines",
    component: MachinesPage,
  });
});
