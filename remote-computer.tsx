// The remote computer: a thread's sandbox desktop, watched in a panel tab and
// driven from a modal that covers the app.
//
// One RFB session serves both. The canvas noVNC draws into is created once,
// in a container this module owns, and moved between whichever host is
// showing it — the panel tab's viewport, or the control modal. Rebuilding the
// session on the way into the modal would mean a reconnect, a fresh
// handshake, and a second of grey where the desktop was.
//
// That shared canvas is why the two components below talk through a
// module-level store rather than through props: the modal is registered as an
// app overlay, so it renders outside the panel's tree and cannot be handed
// anything by the tab.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import RFB from "@novnc/novnc";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** How long the modal's "press ESC" reminder stays up. */
const ESC_HINT_MS = 2_000;

type Phase =
  | { kind: "starting" }
  | { kind: "connected" }
  | { kind: "unavailable"; reason: string }
  | { kind: "error"; message: string };

/**
 * The live session, shared by the panel tab and the control modal.
 *
 * Deliberately a module singleton rather than React state: there is one
 * desktop per sandbox and one canvas for it, and both views have to agree on
 * where that canvas currently lives.
 */
const session = {
  container: null as HTMLDivElement | null,
  rfb: null as RFB | null,
  controlling: false,
  listeners: new Set<() => void>(),

  subscribe(listener: () => void): () => void {
    session.listeners.add(listener);
    return () => session.listeners.delete(listener);
  },

  emit(): void {
    for (const listener of session.listeners) listener();
  },

  /** Move the canvas into `host`, or leave it parked when there is none. */
  attach(host: HTMLElement | null): void {
    if (host === null || session.container === null) return;
    if (session.container.parentElement !== host) host.appendChild(session.container);
    session.rescale();
  },

  /**
   * Re-fit the framebuffer to its host.
   *
   * noVNC recomputes the scale when the property is written, and watches the
   * window rather than the element — so moving between hosts, or a panel
   * resize that leaves the window alone, needs this nudge.
   */
  rescale(): void {
    if (session.rfb !== null) session.rfb.scaleViewport = true;
  },

  /** Put the keyboard back on the remote session. */
  focusRemote(): void {
    if (session.controlling) session.rfb?.focus();
  },

  setControlling(controlling: boolean): void {
    if (session.controlling === controlling) return;
    session.controlling = controlling;
    if (session.rfb !== null) {
      // Inline, the desktop is a picture: a stray click in the panel should
      // never land on the remote machine. Control is what makes it live.
      session.rfb.viewOnly = !controlling;
      if (controlling) session.rfb.focus();
      else session.rfb.blur();
    }
    session.emit();
  },

  close(): void {
    session.rfb?.disconnect();
    session.rfb = null;
    session.container?.remove();
    session.container = null;
    session.controlling = false;
    session.emit();
  },
};

function useControlling(): boolean {
  return useSyncExternalStore(
    session.subscribe,
    () => session.controlling,
    () => false,
  );
}

/**
 * The panel tab: the desktop at the panel's full width, and the way into
 * controlling it.
 *
 * Opening is a single round trip that may be slow the first time — the server
 * installs the desktop on a sandbox whose image predates it — so this stays on
 * "Starting…" for as long as that takes rather than imposing a deadline of
 * its own.
 */
export function RemoteComputerTab({ threadId }: { threadId: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [phase, setPhase] = useState<Phase>({ kind: "starting" });
  const [attempt, setAttempt] = useState(0);
  /** The remote framebuffer's size, known before the first frame arrives. */
  const [geometry, setGeometry] = useState({ width: 1440, height: 900 });
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const controlling = useControlling();

  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: "starting" });

    rpc.call("desktop_open", { threadId }).then(
      (result) => {
        if (cancelled) return;
        if (result.session === null) {
          setPhase({
            kind: "unavailable",
            reason: result.status.reason ?? "This thread has no sandbox desktop.",
          });
          return;
        }
        const { socketPath, password, width, height } = result.session;
        const container = document.createElement("div");
        container.style.width = "100%";
        container.style.height = "100%";

        const url = new URL(socketPath, window.location.href);
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        const rfb = new RFB(container, url.toString(), {
          // One seat: a second client displaces the first rather than sharing
          // a cursor with it.
          shared: false,
          credentials: { password },
        });
        // The remote side is a fixed geometry the server chose, so fit it to
        // the panel rather than asking the desktop to resize to match.
        rfb.resizeSession = false;
        rfb.scaleViewport = true;
        rfb.viewOnly = true;
        rfb.focusOnClick = false;
        rfb.background = "transparent";

        rfb.addEventListener("connect", () => {
          if (!cancelled) setPhase({ kind: "connected" });
        });
        rfb.addEventListener("disconnect", (event) => {
          const clean = (event as CustomEvent<{ clean: boolean }>).detail.clean;
          session.controlling = false;
          session.rfb = null;
          if (cancelled) return;
          setPhase({
            kind: "error",
            message: clean
              ? "The desktop connection closed."
              : "Lost the connection to the desktop.",
          });
          session.emit();
        });
        rfb.addEventListener("securityfailure", (event) => {
          const { reason } = (event as CustomEvent<{ reason?: string }>).detail;
          if (!cancelled) {
            setPhase({
              kind: "error",
              message: reason ?? "The desktop rejected the connection.",
            });
          }
        });

        session.container = container;
        session.rfb = rfb;
        session.attach(viewportRef.current);
        // Shape the viewport before the first frame lands, so it does not
        // jump when one does.
        setGeometry({ width, height });
      },
      (error: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );

    return () => {
      cancelled = true;
      session.close();
    };
  }, [rpc, threadId, attempt]);

  // The canvas lives in the modal while it is open; take it back on the way
  // out, and after any re-render that replaced the viewport element.
  useEffect(() => {
    if (!controlling) session.attach(viewportRef.current);
  }, [controlling, phase]);

  // A panel resize moves no window, so noVNC would not hear about it.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === null) return;
    const observer = new ResizeObserver(() => session.rescale());
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  if (phase.kind === "unavailable" || phase.kind === "error") {
    return (
      <Message
        icon={phase.kind === "unavailable" ? "CloudOff" : "AlertTriangle"}
        title={
          phase.kind === "unavailable"
            ? "No desktop for this thread yet"
            : "The desktop stopped"
        }
        detail={phase.kind === "unavailable" ? phase.reason : phase.message}
        onRetry={retry}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 p-3">
      <div
        className="group relative w-full overflow-hidden rounded-md border bg-black/90"
        style={{ aspectRatio: `${geometry.width} / ${geometry.height}` }}
      >
        <div ref={viewportRef} className="absolute inset-0" />
        {phase.kind === "starting" ? (
          <div className="absolute inset-0 grid place-items-center text-sm text-muted-foreground">
            Starting the remote desktop…
          </div>
        ) : (
          // Hover-only, so the desktop is unobstructed while it is being
          // watched rather than driven.
          <div className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <Button onClick={() => session.setControlling(true)}>
              <Icon name="Maximize2" className="mr-1.5 size-4" aria-hidden />
              Click to control
            </Button>
          </div>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        {phase.kind === "connected"
          ? "Controlling opens the desktop over the app. Press ESC to come back."
          : // Normally seconds: the packages ship with the sandbox, so this is
            // starting a display and a VNC server, not installing them. The
            // exception is a sandbox that predates the desktop, which has to
            // fetch them first — worth naming, since that is the slow case.
            "Starting the display and VNC server. A sandbox created before this feature installs them first, which takes longer."}
      </p>
    </div>
  );
}

/** The tab's empty states: why there is nothing to show, and a way to retry. */
function Message({
  icon,
  title,
  detail,
  onRetry,
}: {
  icon: IconName;
  title: string;
  detail: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-sm space-y-3 text-center">
        <Icon name={icon} className="mx-auto size-6 opacity-50" aria-hidden />
        <p className="text-sm font-medium">{title}</p>
        <p className="text-sm text-muted-foreground">{detail}</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <Icon name="RotateCcw" className="mr-1.5 size-4" aria-hidden />
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * The control modal: the desktop over the whole app, taking the keyboard and
 * mouse with it.
 *
 * Registered as an app overlay rather than as a dialog inside the panel so it
 * covers the app the way the quick palette does, and so the panel tab can be
 * narrow without the controlled desktop being narrow too.
 */
export function RemoteComputerOverlay() {
  const controlling = useControlling();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [showHint, setShowHint] = useState(false);

  useEffect(() => {
    if (!controlling) return;
    session.attach(hostRef.current);
    // Moving a focused element between parents drops its focus in some
    // browsers, and without focus the keyboard goes nowhere.
    session.focusRemote();
    setShowHint(true);
    const timer = window.setTimeout(() => setShowHint(false), ESC_HINT_MS);
    return () => window.clearTimeout(timer);
  }, [controlling]);

  if (!controlling) return null;

  const release = () => session.setControlling(false);

  return (
    <div
      className="fixed inset-0 z-[100] flex flex-col bg-black/95 backdrop-blur-sm"
      // Escape is intercepted on the way down, before noVNC's own handler on
      // the canvas can claim it and send it to the remote machine: it is the
      // one key this modal keeps for itself.
      onKeyDownCapture={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        release();
      }}
      // Everything else has already reached noVNC by the time it bubbles to
      // here. Stopping it here is what keeps BB's own shortcuts from firing
      // on keystrokes meant for the remote machine.
      onKeyDown={(event) => event.stopPropagation()}
      onKeyUp={(event) => event.stopPropagation()}
    >
      <div className="flex items-center justify-between px-4 py-2 text-xs text-white/70">
        <span>Remote computer — this window has the keyboard and mouse</span>
        <Button
          variant="ghost"
          size="sm"
          className="text-white/80 hover:text-white"
          onClick={release}
        >
          <Icon name="Minimize2" className="mr-1.5 size-4" aria-hidden />
          Release (ESC)
        </Button>
      </div>
      <div ref={hostRef} className="min-h-0 flex-1" />
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 top-16 mx-auto w-fit rounded-md bg-white/90 px-3 py-1.5 text-sm font-medium text-black transition-opacity duration-300",
          showHint ? "opacity-100" : "opacity-0",
        )}
        role="status"
      >
        Press ESC to exit
      </div>
    </div>
  );
}
