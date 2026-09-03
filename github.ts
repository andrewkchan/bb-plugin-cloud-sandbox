// The git identity and GitHub token every cloud machine is given.
//
// These are account-level rather than per-template: one person has one git
// identity, and a token that can push is not something to configure again for
// each image.
//
// The values are read from the GitHub CLI's own login on the bb host. That is
// deliberately not an OAuth flow of this plugin's own: `gh` already holds a
// token with whatever scopes and organization authorizations the user has
// granted, which is exactly the access they expect a machine to have.
//
// Like machines.ts and templates.ts this module carries no bb dependency.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Where Homebrew and the official installer put `gh`, for a bare PATH. */
const GH_FALLBACK_PATHS = [
  "/opt/homebrew/bin/gh",
  "/usr/local/bin/gh",
  "/usr/bin/gh",
];

/** `gh` can hang on a slow network; a button press must not hang with it. */
const GH_TIMEOUT_MS = 10_000;

/** The environment variables this identity is injected as. */
export const GIT_AUTHOR_NAME = "GIT_AUTHOR_NAME";
export const GIT_AUTHOR_EMAIL = "GIT_AUTHOR_EMAIL";
export const GH_TOKEN = "GH_TOKEN";
export const GITHUB_KEYS = [GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GH_TOKEN];

export interface GitHubProfile {
  /** The account the values came from, shown so a wrong import is obvious. */
  login: string;
  name: string;
  /** Public avatar URL; needs no credentials of its own to load. */
  avatarUrl: string;
}

export interface GitHubIdentity extends GitHubProfile {
  email: string;
  token: string;
}

/**
 * A failure worth showing a user, phrased as what to do about it.
 *
 * Separated from ordinary errors because every one of these is actionable and
 * none of them is a bug in the plugin.
 */
export class GitHubImportError extends Error {}

/**
 * The committer git falls back to when only an author was given.
 *
 * A machine with GIT_AUTHOR_NAME but no GIT_COMMITTER_NAME commits as
 * whatever git guesses from the container's user and hostname, which is not
 * what anyone filling in a name meant. Asking for the same two values twice
 * would be worse, so they are copied over.
 */
export function withDerivedGitIdentity(
  env: Record<string, string>,
): Record<string, string> {
  const derived = { ...env };
  for (const field of ["NAME", "EMAIL"]) {
    const author = derived[`GIT_AUTHOR_${field}`];
    if (author !== undefined && derived[`GIT_COMMITTER_${field}`] === undefined) {
      derived[`GIT_COMMITTER_${field}`] = author;
    }
  }
  return derived;
}

/**
 * Ask `gh` for its token.
 *
 * `gh auth token` reports a token it cannot read from the system keyring with
 * the same "no oauth token found" it uses for an account that was never
 * signed in, so the two cannot be told apart and the message has to cover
 * both.
 */
async function readToken(): Promise<string> {
  let lastError: unknown = null;
  for (const bin of ["gh", ...GH_FALLBACK_PATHS]) {
    try {
      const { stdout } = await run(bin, ["auth", "token"], {
        timeout: GH_TIMEOUT_MS,
      });
      const token = stdout.trim();
      if (token === "") {
        throw new GitHubImportError("`gh auth token` returned nothing.");
      }
      return token;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // Not on this path: try the next one before concluding anything.
      if (code === "ENOENT") {
        lastError = error;
        continue;
      }
      if (error instanceof GitHubImportError) throw error;
      throw new GitHubImportError(
        "`gh` is installed but has no usable token. Either it is not signed " +
          "in, or it could not read the token from the system keyring. Run " +
          "`gh auth status` in a terminal to see which, then `gh auth login` " +
          "if it asks you to.",
      );
    }
  }
  throw new GitHubImportError(
    lastError === null
      ? "Could not run the GitHub CLI (`gh`)."
      : "The GitHub CLI (`gh`) was not found. Install it, or check that it is " +
        "on the PATH the bb app was started with.",
  );
}

interface GitHubUser {
  login: string;
  id: number;
  name: string | null;
  email: string | null;
  avatar_url: string;
}

interface GitHubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

async function api<T>(path: string, token: string): Promise<T | null> {
  const response = await fetch(`https://api.github.com${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "user-agent": "bb-plugin-cloud-sandbox",
    },
    signal: AbortSignal.timeout(GH_TIMEOUT_MS),
  });
  if (response.status === 401) {
    throw new GitHubImportError(
      "The token from `gh` was rejected by GitHub — it has expired or been " +
        "revoked. Run `gh auth login` in a terminal, then import again.",
    );
  }
  // A missing scope is not fatal for every call: the caller decides.
  if (response.status === 403 || response.status === 404) return null;
  if (!response.ok) {
    throw new GitHubImportError(
      `GitHub returned ${response.status} for ${path}.`,
    );
  }
  return (await response.json()) as T;
}

/**
 * Read the local `gh` login and turn it into the three values a machine
 * needs.
 *
 * The API calls are not only for the name and email: they are what proves the
 * token still works. `gh auth token` prints a revoked token just as happily as
 * a live one, and a machine created with a dead token fails much later, in a
 * place that is far harder to connect back to this button.
 */
export async function importLocalGitHubIdentity(): Promise<GitHubIdentity> {
  const token = await readToken();
  const user = await readUser(token);

  // A public profile email is not necessarily the one to commit as, and is
  // null whenever email privacy is on, so the address list decides.
  const emails = await api<GitHubEmail[]>("/user/emails", token);
  const primary = emails?.find((entry) => entry.primary && entry.verified);
  const email =
    primary?.email ??
    user.email ??
    // What GitHub itself commits as for a private address; it still attributes
    // the commit to the account.
    `${user.id}+${user.login}@users.noreply.github.com`;

  return {
    ...toProfile(user),
    email,
    token,
  };
}

function toProfile(user: GitHubUser): GitHubProfile {
  return {
    login: user.login,
    // Plenty of accounts have no display name set.
    name: user.name ?? user.login,
    avatarUrl: user.avatar_url,
  };
}

async function readUser(token: string): Promise<GitHubUser> {
  const user = await api<GitHubUser>("/user", token);
  if (user === null) {
    throw new GitHubImportError(
      "The token cannot read your GitHub account. It is missing the " +
        "`read:user` scope.",
    );
  }
  return user;
}

/**
 * Who a stored token belongs to.
 *
 * A token typed in by hand carries no account with it, so this is what puts a
 * name and a face on it. The same call also confirms the token still works.
 */
export async function readProfile(token: string): Promise<GitHubProfile> {
  return toProfile(await readUser(token));
}
