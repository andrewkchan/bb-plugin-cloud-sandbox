/**
 * The part of noVNC's RFB class this plugin uses.
 *
 * noVNC ships no type declarations, and its API is documented rather than
 * typed (node_modules/@novnc/novnc/docs/API.md). Declaring only what is used
 * keeps the compiler honest about the calls we actually make instead of
 * pretending the whole surface is known.
 */
declare module "@novnc/novnc" {
  interface RfbOptions {
    /** False disconnects any other client, which is the single-seat rule. */
    shared?: boolean;
    credentials?: { username?: string; password?: string; target?: string };
    wsProtocols?: string[];
  }

  export default class RFB extends EventTarget {
    constructor(
      target: HTMLElement,
      urlOrChannel: string | WebSocket,
      options?: RfbOptions,
    );
    /** True ignores local input entirely — the panel's inline state. */
    viewOnly: boolean;
    /** Scales the remote framebuffer to fit the target element. */
    scaleViewport: boolean;
    /** Asks the server to resize to the target element. Off: fixed geometry. */
    resizeSession: boolean;
    /** CSS background behind a letterboxed framebuffer. */
    background: string;
    /** Whether clicking the session takes keyboard focus. */
    focusOnClick: boolean;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    blur(): void;
  }
}
