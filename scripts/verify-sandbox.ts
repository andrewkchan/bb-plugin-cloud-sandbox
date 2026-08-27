// Standalone Vercel Sandbox verification — no bb server required.
//
//   vercel link && vercel env pull            # writes .env.local (VERCEL_OIDC_TOKEN)
//   npm run verify:sandbox
//
// Boots a real sandbox, runs code inside it, prints the captured output, and
// exits non-zero if anything did not come back as expected.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runCode, type SandboxCredentials } from "../sandbox.ts";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * Load `.env.local` (what `vercel env pull` writes) into process.env without
 * clobbering variables already set in the shell.
 */
function loadDotEnvLocal(): void {
  let contents: string;
  try {
    contents = readFileSync(join(ROOT, ".env.local"), "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(
      line,
    );
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^(['"])(.*)\1$/s, "$2");
  }
}

/**
 * Prefer an explicit personal access token when all three parts are present;
 * otherwise fall back to the OIDC token, which the SDK reads from the
 * environment on its own.
 */
function resolveCredentials(): SandboxCredentials | undefined {
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectId = process.env.VERCEL_PROJECT_ID;
  if (token && teamId && projectId) return { token, teamId, projectId };
  return undefined;
}

const NODE_SNIPPET = `
const sum = [1, 2, 3, 4].reduce((total, n) => total + n, 0);
console.log("hello from the sandbox");
console.log("node " + process.version + " on " + process.platform + "/" + process.arch);
console.log("sum=" + sum);
console.error("this line went to stderr");
`;

async function main(): Promise<void> {
  loadDotEnvLocal();

  const credentials = resolveCredentials();
  if (credentials === undefined && !process.env.VERCEL_OIDC_TOKEN) {
    console.error(
      [
        "No Vercel credentials found.",
        "",
        "Either run, from this directory:",
        "  vercel link      # pick or create the Vercel project",
        "  vercel env pull  # writes .env.local with VERCEL_OIDC_TOKEN",
        "",
        "or export VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.",
      ].join("\n"),
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `Authenticating with ${credentials ? "an explicit access token" : "VERCEL_OIDC_TOKEN"}.`,
  );
  console.log("Booting a sandbox and running a Node snippet inside it…\n");

  const result = await runCode(NODE_SNIPPET, "node", {
    ...(credentials === undefined ? {} : { credentials }),
    sandboxTimeoutMs: 120_000,
    commandTimeoutMs: 60_000,
  });

  console.log(`sandbox   ${result.sandboxName}`);
  console.log(`booted in ${result.createdInMs}ms, ran in ${result.ranInMs}ms`);
  console.log(`exit code ${result.exitCode}`);
  console.log(`\n--- stdout ---\n${result.stdout.trimEnd()}`);
  console.log(`\n--- stderr ---\n${result.stderr.trimEnd()}`);

  const failures: string[] = [];
  if (result.exitCode !== 0) failures.push(`exit code was ${result.exitCode}`);
  if (!result.stdout.includes("hello from the sandbox")) {
    failures.push("stdout did not contain the expected greeting");
  }
  if (!result.stdout.includes("sum=10")) {
    failures.push("stdout did not contain the computed result (sum=10)");
  }
  if (!result.stderr.includes("this line went to stderr")) {
    failures.push("stderr was not captured separately");
  }

  if (failures.length > 0) {
    console.error(`\nFAILED:\n- ${failures.join("\n- ")}`);
    process.exitCode = 1;
    return;
  }
  console.log("\nOK — sandbox booted, executed code, and returned its output.");
}

await main();
