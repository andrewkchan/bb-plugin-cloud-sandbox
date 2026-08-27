// Vercel OAuth 2.0 Device Authorization Grant (RFC 8628).
//
// Why this is hand-rolled rather than calling @vercel/sandbox's OAuth():
// that helper hardcodes its own client id as a module constant with no
// parameter and no env override, so it cannot be pointed at a different
// OAuth client. It also lives behind a deep `dist/` import. Implementing the
// grant directly is ~100 lines of a standard spec, keeps the client id
// swappable, and depends only on Vercel's public discovery document.
//
// Like sandbox.ts this module carries no bb dependency.

/**
 * The client id @vercel/sandbox ships. It works out of the box, but it is
 * Vercel's own client: the consent screen is not branded for this plugin and
 * Vercel may rotate it. Override it with the `oauthClientId` setting once you
 * register your own Vercel integration.
 */
export const DEFAULT_CLIENT_ID = "cl_HYyOPBNtFMfHhaUn9L4QPfTZz6TP47bp";

const ISSUER = "https://vercel.com";
/** `offline_access` is what gets us a refresh token; a bb server outlives one access token. */
const SCOPE = "openid offline_access";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

/** What the user has to do to approve the sign-in. */
export interface DeviceAuthorization {
  deviceCode: string;
  /** Short code the user confirms on Vercel. */
  userCode: string;
  /** Bare URL, where the user types `userCode` themselves. */
  verificationUri: string;
  /** URL with the code embedded — this is the one to open for them. */
  verificationUriComplete: string;
  /** Seconds to wait between polls, per the authorization server. */
  intervalSeconds: number;
  /** Epoch ms after which `deviceCode` is dead. */
  expiresAt: number;
}

/** A resolved session, ready to persist. */
export interface AuthSession {
  accessToken: string;
  refreshToken: string | null;
  /** Epoch ms. */
  expiresAt: number;
}

interface DiscoveryDocument {
  device_authorization_endpoint: string;
  token_endpoint: string;
  revocation_endpoint: string;
}

let discoveryCache: DiscoveryDocument | null = null;

async function discover(): Promise<DiscoveryDocument> {
  if (discoveryCache !== null) return discoveryCache;
  const response = await fetch(`${ISSUER}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(
      `Vercel OIDC discovery failed (${response.status} ${response.statusText}).`,
    );
  }
  const document = (await response.json()) as Partial<DiscoveryDocument>;
  const missing = (
    [
      "device_authorization_endpoint",
      "token_endpoint",
      "revocation_endpoint",
    ] as const
  ).filter((key) => typeof document[key] !== "string");
  if (missing.length > 0) {
    throw new Error(
      `Vercel OIDC discovery document is missing: ${missing.join(", ")}.`,
    );
  }
  discoveryCache = document as DiscoveryDocument;
  return discoveryCache;
}

/** An `error` payload from the token endpoint, per RFC 6749 §5.2. */
interface OAuthErrorBody {
  error: string;
  error_description?: string;
}

function describeError(body: OAuthErrorBody): string {
  return body.error_description
    ? `${body.error}: ${body.error_description}`
    : body.error;
}

/** Step 1: ask Vercel for a code the user can approve in a browser. */
export async function startDeviceAuthorization(
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<DeviceAuthorization> {
  const { device_authorization_endpoint } = await discover();
  const response = await fetch(device_authorization_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope: SCOPE }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Could not start Vercel sign-in — ${describeError(body as unknown as OAuthErrorBody)}`,
    );
  }
  return {
    deviceCode: String(body.device_code),
    userCode: String(body.user_code),
    verificationUri: String(body.verification_uri),
    verificationUriComplete: String(body.verification_uri_complete),
    intervalSeconds: typeof body.interval === "number" ? body.interval : 5,
    expiresAt:
      Date.now() +
      (typeof body.expires_in === "number" ? body.expires_in : 900) * 1000,
  };
}

function toSession(body: Record<string, unknown>): AuthSession {
  return {
    accessToken: String(body.access_token),
    refreshToken:
      typeof body.refresh_token === "string" ? body.refresh_token : null,
    expiresAt:
      Date.now() +
      (typeof body.expires_in === "number" ? body.expires_in : 3600) * 1000,
  };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error("Vercel sign-in was cancelled."));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Vercel sign-in was cancelled."));
      },
      { once: true },
    );
  });
}

/**
 * Step 2: poll until the user approves, declines, or the code expires.
 *
 * Honours the two flow-control responses the spec defines: `authorization_pending`
 * means keep waiting, `slow_down` means back off (the server may otherwise
 * start rejecting us for polling too fast).
 */
export async function pollForSession(
  authorization: DeviceAuthorization,
  clientId: string = DEFAULT_CLIENT_ID,
  signal?: AbortSignal,
): Promise<AuthSession> {
  const { token_endpoint } = await discover();
  let intervalMs = authorization.intervalSeconds * 1000;

  while (Date.now() < authorization.expiresAt) {
    await sleep(intervalMs, signal);

    const response = await fetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: authorization.deviceCode,
        grant_type: DEVICE_GRANT,
      }),
      ...(signal === undefined ? {} : { signal }),
    });
    const body = (await response.json()) as Record<string, unknown>;

    if (response.ok) return toSession(body);

    switch (body.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        // The spec's remedy is to add 5 seconds and carry on.
        intervalMs += 5000;
        continue;
      case "access_denied":
        throw new Error("Vercel sign-in was declined.");
      case "expired_token":
        throw new Error("The Vercel sign-in code expired. Start again.");
      default:
        throw new Error(
          `Vercel sign-in failed — ${describeError(body as unknown as OAuthErrorBody)}`,
        );
    }
  }
  throw new Error("The Vercel sign-in code expired. Start again.");
}

/** Exchange a refresh token for a fresh access token. */
export async function refreshSession(
  refreshToken: string,
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<AuthSession> {
  const { token_endpoint } = await discover();
  const response = await fetch(token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(
      `Could not refresh the Vercel session — ${describeError(body as unknown as OAuthErrorBody)}`,
    );
  }
  const session = toSession(body);
  // Vercel may or may not rotate the refresh token; keep the old one if not.
  return {
    ...session,
    refreshToken: session.refreshToken ?? refreshToken,
  };
}

/** Best-effort revocation on sign-out. */
export async function revokeToken(
  token: string,
  clientId: string = DEFAULT_CLIENT_ID,
): Promise<void> {
  const { revocation_endpoint } = await discover();
  await fetch(revocation_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, token }),
  });
}
