// The remote desktop a sandbox can show, and the socket the panel watches it
// through.
//
// Three things have to line up before a frame reaches the panel:
//
//   1. the sandbox runs an X display, a VNC server and a WebSocket bridge
//      (scripts/desktop.sh);
//   2. the bridge's port is routed to a public *.vercel.run hostname, which
//      is a property of the sandbox and has to be asked for;
//   3. the panel connects to *this plugin's* WebSocket route, which relays to
//      that hostname.
//
// The third hop is what keeps the sandbox's hostname and VNC password on the
// server. A Vercel sandbox route is reachable by anyone who knows it, so the
// password is what actually guards the desktop — and the browser only ever
// sees a short-lived ticket for our own socket instead.
import { randomBytes, randomUUID } from "node:crypto";
import type {
  BbPluginApi,
  ExperimentalPluginWebSocket,
} from "@get-bb/plugin-sdk";
import type { Sandbox } from "@vercel/sandbox";
import {
  execInSandbox,
  findSandbox,
  DESKTOP_SCRIPT,
  type SandboxCredentials,
} from "./machines.js";

/** The port the sandbox's WebSocket bridge listens on, and the one we route. */
const BRIDGE_PORT = 6080;

/** The desktop's size. Fixed: the RFB session is created before the panel is. */
export const DESKTOP_GEOMETRY = { width: 1440, height: 900 };

/** Starting the desktop installs packages the first time; allow for that. */
const START_TIMEOUT_MS = 10 * 60_000;

/** A ticket is redeemed the moment the panel opens its socket. */
const TICKET_TTL_MS = 60_000;

/** One ticket: permission to relay to one sandbox, once. */
interface Ticket {
  sandboxName: string;
  endpoint: string;
  expiresAt: number;
}

export interface DesktopSession {
  /** Redeem at this plugin's `desktop` WebSocket route. */
  ticket: string;
  /** The RFB password, which the client needs to finish the handshake. */
  password: string;
  width: number;
  height: number;
}

/**
 * Per-sandbox VNC passwords.
 *
 * Kept in memory rather than in plugin storage: the sandbox is told the
 * password every time the desktop is started, so forgetting it across a
 * plugin reload costs a restart of x11vnc, not access to anything.
 */
const passwords = new Map<string, string>();

function passwordFor(sandboxName: string): string {
  const existing = passwords.get(sandboxName);
  if (existing !== undefined) return existing;
  // x11vnc truncates an RFB password at 8 characters, so a longer one would
  // be security theatre. 8 base64url characters is ~48 bits.
  const password = randomBytes(6).toString("base64url");
  passwords.set(sandboxName, password);
  return password;
}

const tickets = new Map<string, Ticket>();

function issueTicket(sandboxName: string, endpoint: string): string {
  const now = Date.now();
  for (const [id, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(id);
  }
  const id = randomUUID();
  tickets.set(id, { sandboxName, endpoint, expiresAt: now + TICKET_TTL_MS });
  return id;
}

/** Redeem a ticket, consuming it. Null when unknown or expired. */
export function redeemTicket(id: string | null): Ticket | null {
  if (id === null) return null;
  const ticket = tickets.get(id);
  if (ticket === undefined) return null;
  tickets.delete(id);
  return ticket.expiresAt <= Date.now() ? null : ticket;
}

/**
 * Make sure the bridge's port is routed, and answer with its wss:// URL.
 *
 * `update` takes the full desired port list, so the sandbox's existing routes
 * are preserved by being named again; a sandbox that already routes the port
 * is left alone.
 */
async function routeBridge(
  credentials: SandboxCredentials,
  sandbox: Sandbox,
): Promise<{ sandbox: Sandbox; endpoint: string }> {
  let current = sandbox;
  if (!current.routes.some((route) => route.port === BRIDGE_PORT)) {
    const ports = [
      ...new Set([...current.routes.map((route) => route.port), BRIDGE_PORT]),
    ];
    await current.update({ ports });
    // The routes on hand were read before the update; re-read rather than
    // assume what the API assigned.
    const refreshed = await findSandbox(credentials, current.name);
    if (refreshed === null) {
      throw new Error("The sandbox disappeared while exposing its desktop.");
    }
    current = refreshed;
  }
  let domain: string;
  try {
    domain = current.domain(BRIDGE_PORT);
  } catch {
    // `domain` throws when the port carries no route. Asking for one is all
    // this plugin can do about that, and it just did.
    throw new Error(
      "This sandbox is not routing its desktop port yet. It may need to be restarted.",
    );
  }
  return {
    sandbox: current,
    endpoint: `${domain.replace(/^http/u, "ws")}/`,
  };
}

/**
 * Start the named sandbox's desktop if it is not already up, and issue a
 * ticket for it.
 *
 * Safe to call on every connect: the script it runs is idempotent, which is
 * what makes reconnecting after a wake — where the VM came back but its
 * processes did not — the same code path as connecting the first time.
 */
export async function openDesktop(options: {
  credentials: SandboxCredentials;
  sandboxName: string;
  signal: AbortSignal;
  onOutput?: (chunk: string) => void;
}): Promise<DesktopSession> {
  const { credentials, sandboxName, signal, onOutput } = options;
  const found = await findSandbox(credentials, sandboxName, { signal });
  if (found === null) {
    throw new Error("This thread's sandbox no longer exists.");
  }
  const { sandbox, endpoint } = await routeBridge(credentials, found);
  const password = passwordFor(sandboxName);
  const geometry = `${DESKTOP_GEOMETRY.width}x${DESKTOP_GEOMETRY.height}`;
  const exitCode = await execInSandbox(sandbox, {
    command: ["bash", "-lc", DESKTOP_SCRIPT, "bb-desktop", password, geometry],
    stdin: "",
    timeoutMs: START_TIMEOUT_MS,
    signal,
    onOutput: onOutput ?? (() => undefined),
  });
  if (exitCode !== 0) {
    throw new Error(`Starting the remote desktop failed (exit ${exitCode}).`);
  }
  return {
    ticket: issueTicket(sandboxName, endpoint),
    password,
    width: DESKTOP_GEOMETRY.width,
    height: DESKTOP_GEOMETRY.height,
  };
}

/**
 * One relayed socket: the panel's socket on one side, the sandbox's bridge on
 * the other.
 *
 * Frames pass through untouched — the RFB handshake, and the password with
 * it, happens end to end between noVNC and x11vnc, and this end never sees
 * anything it could weaken.
 */
interface Relay {
  client: ExperimentalPluginWebSocket;
  upstream: WebSocket;
}

/**
 * The live relay per sandbox.
 *
 * There is one desktop behind each sandbox, so there is one seat. The panel
 * launcher already focuses an open tab rather than opening a second, but a
 * second BB window is a second client; the newcomer takes the seat and the
 * old socket is closed, told why. x11vnc does the same thing one hop further
 * in, so this keeps our side of it honest rather than inventing a policy.
 */
const relays = new Map<string, Relay>();

/** Closed by us to hand the desktop to a newer client. */
export const TAKEN_OVER_CODE = 4001;

export function registerDesktopSocket(bb: BbPluginApi): void {
  bb.http.experimental_websocket("/desktop", (context) => {
    const ticket = redeemTicket(context.url.searchParams.get("ticket"));
    let upstream: WebSocket | null = null;
    // Frames the panel sends before the far side is open. noVNC starts
    // talking as soon as its socket opens, which is before ours has finished
    // connecting outwards.
    const pending: (string | Uint8Array)[] = [];

    return {
      onOpen(client) {
        if (ticket === null) {
          client.close(4003, "Expired desktop ticket; reopen the tab.");
          return;
        }
        const previous = relays.get(ticket.sandboxName);
        if (previous !== undefined) {
          previous.client.close(TAKEN_OVER_CODE, "Opened somewhere else.");
        }

        // No subprotocol, which is what noVNC negotiates by default and so
        // what the bridge on the other side expects. Neither end of this
        // relay interprets what the frames carry.
        const socket = new WebSocket(ticket.endpoint);
        socket.binaryType = "arraybuffer";
        upstream = socket;
        relays.set(ticket.sandboxName, { client, upstream: socket });

        socket.addEventListener("open", () => {
          for (const frame of pending.splice(0)) socket.send(frame);
        });
        socket.addEventListener("message", (event: MessageEvent) => {
          const { data } = event;
          client.send(
            typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer),
          );
        });
        socket.addEventListener("close", () => {
          if (relays.get(ticket.sandboxName)?.upstream === socket) {
            relays.delete(ticket.sandboxName);
          }
          client.close(1011, "The sandbox closed the desktop connection.");
        });
        socket.addEventListener("error", () => {
          client.close(1011, "Could not reach the sandbox's desktop.");
        });
      },

      onMessage(_client, data) {
        if (upstream === null) return;
        if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        else pending.push(data);
      },

      onClose() {
        if (ticket !== null && relays.get(ticket.sandboxName)?.upstream === upstream) {
          relays.delete(ticket.sandboxName);
        }
        upstream?.close();
      },

      onError() {
        upstream?.close();
      },
    };
  });
}
