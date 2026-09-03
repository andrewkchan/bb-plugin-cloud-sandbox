// Templates: what a cloud machine is made of.
//
// A template's image is an OCI image in Vercel Container Registry, and nothing
// in the SDK builds one: `vercel vcr build`/`push` shell out to docker, podman
// or buildah. Rather than require a container engine on the bb host, a build
// runs inside a throwaway sandbox that installs buildah itself.
//
// "image" is used below only where it means that OCI artifact; the plugin
// concept that owns it is a template.
//
// Like machines.ts and auth.ts this module carries no bb dependency.
import { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import {
  deleteSandboxWithSnapshots,
  type SandboxCredentials,
} from "./machines.js";

/** The registry every image is pushed to. */
export const REGISTRY_HOST = "vcr.vercel.com";
/** The single repository this plugin keeps its images in. */
export const DEFAULT_REPOSITORY = "bb-cloud-machine";

/**
 * The base every image is built from.
 *
 * Not `vercel/sandbox/ubuntu`: that is a Vercel-internal shorthand accepted by
 * `Sandbox.create({ image })`, and `vcr.vercel.com/vercel/sandbox/ubuntu`
 * returns 404. This is the same distribution the managed image runs.
 */
export const BASE_IMAGE = "docker.io/library/ubuntu:26.04";

/**
 * Starting points offered when creating an image.
 *
 * A preset only seeds the name and commands of a new image; it is ordinary
 * editable configuration afterwards, not a link that keeps updating.
 */
export interface TemplatePreset {
  id: string;
  label: string;
  description: string;
  name: string;
  commands: string;
}

export const TEMPLATE_PRESETS: TemplatePreset[] = [
  {
    id: "blank",
    label: "Blank",
    description: "bb's prerequisites only.",
    name: "Image",
    commands: "",
  },
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Installs the Claude Code CLI.",
    name: "Claude Code",
    commands: "npm install -g @anthropic-ai/claude-code",
  },
  {
    id: "pi",
    label: "pi.dev",
    description: "Installs the pi coding agent.",
    name: "pi.dev",
    // --ignore-scripts is what pi's own install instructions use.
    commands: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent",
  },
];

export function findPreset(id: string): TemplatePreset | null {
  return TEMPLATE_PRESETS.find((preset) => preset.id === id) ?? null;
}

export interface BuildImageOptions {
  credentials: SandboxCredentials;
  /** Team slug, for the registry path and the Vercel CLI's --scope. */
  teamSlug: string;
  /** Project id, for the registry path and the Vercel CLI's --project. */
  projectId: string;
  /** Tag this image is published under, unique per image. */
  tag: string;
  /** Shell run after bb's prerequisites are installed. May be empty. */
  commands: string;
  /** How long the build sandbox may live. */
  timeoutMs?: number;
  vcpus?: number;
  signal?: AbortSignal;
  /** Called with each stage's output so a running build can stream its log. */
  onLog?: (chunk: string) => void | Promise<void>;
}

export interface BuildImageResult {
  /** The reference to pass to `Sandbox.create({ image })`. */
  imageRef: string;
  /** Fully qualified registry reference, for the Vercel dashboard. */
  registryRef: string;
  log: string;
}

/**
 * Reject a name the shell could not export.
 */
export function assertSafeEnvKey(key: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(
      `Invalid environment variable name "${key}". Use letters, digits and underscores, not starting with a digit.`,
    );
  }
}

/**
 * The Dockerfile an image is built from.
 *
 * bb's prerequisites go in first so they are cached below the user's own
 * layers: Node (the host daemon needs 22.19+, and the stock Ubuntu base ships
 * none) and a C toolchain, because bb-app's node-pty is a native add-on built
 * from source at enrolment. Baking these is most of what makes a machine
 * created from a custom image faster than one built from scratch.
 *
 * Note build commands cannot see template env vars, which are instead injected
 * at sandbox creation time.
 */
export function buildDockerfile(commands: string): string {
  const lines = [
    `FROM ${BASE_IMAGE}`,
    "ENV DEBIAN_FRONTEND=noninteractive",
    // One layer: bb's prerequisites.
    "RUN apt-get update -qq && apt-get install -y -qq --no-install-recommends " +
      "ca-certificates curl git build-essential python3 sudo && " +
      "curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && " +
      "apt-get install -y -qq nodejs && " +
      "rm -rf /var/lib/apt/lists/*",
  ];
  const trimmed = commands.trim();
  if (trimmed !== "") {
    // Run the user's script as one layer through a heredoc, so multi-line
    // input needs no escaping and a failing line fails the build.
    lines.push(
      "RUN set -eux; \\",
      ...trimmed.split("\n").map((line) => `    ${line}; \\`),
      "    true",
    );
  }
  return lines.join("\n") + "\n";
}

/**
 * Build an image and push it to the registry.
 *
 * The build runs in its own sandbox, which is always deleted — a leaked build
 * VM bills until its own timeout and serves no purpose once the image is
 * pushed.
 */
export async function buildImage(
  options: BuildImageOptions,
): Promise<BuildImageResult> {
  const {
    credentials,
    teamSlug,
    projectId,
    tag,
    commands,
    timeoutMs = 30 * 60_000,
    vcpus = 4,
    signal,
    onLog,
  } = options;

  const registryRef = `${REGISTRY_HOST}/${teamSlug}/${projectId}/${DEFAULT_REPOSITORY}:${tag}`;
  const dockerfile = buildDockerfile(commands);

  const sandbox = await Sandbox.create({
    ...credentials,
    timeout: timeoutMs,
    resources: { vcpus },
    ...(signal === undefined ? {} : { signal }),
  });

  let log = "";
  const stage = async (label: string, script: string): Promise<void> => {
    const finished = await sandbox.runCommand({
      cmd: "bash",
      args: ["-lc", script],
      timeoutMs: Math.min(timeoutMs, 25 * 60_000),
      ...(signal === undefined ? {} : { signal }),
    });
    const [stdout, stderr] = await Promise.all([
      finished.stdout(),
      finished.stderr(),
    ]);
    const chunk =
      `\n=== ${label} ===\n${stdout}${stderr === "" ? "" : `\n${stderr}`}`.trimEnd() +
      "\n";
    log += chunk;
    await onLog?.(chunk);
    if (finished.exitCode !== 0) {
      throw new Error(`${label} failed (exit ${finished.exitCode}).`);
    }
  };

  try {
    const cli = `--project ${projectId} --scope ${teamSlug} --token ${credentials.token} --cwd /tmp`;

    await stage(
      "Install build tooling",
      "sudo apt-get update -qq && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq buildah >/dev/null 2>&1 && npm i -g vercel >/dev/null 2>&1 && buildah --version && vercel --version",
    );
    // Creating a repository that already exists is not an error worth failing
    // the build over; the push below is what actually matters.
    await stage(
      "Ensure registry repository",
      `vercel vcr add ${DEFAULT_REPOSITORY} ${cli} 2>&1 | tail -3 || true`,
    );
    await stage("Authenticate registry", `vercel vcr login buildah ${cli} >/dev/null 2>&1 && echo "authenticated"`);
    await stage(
      "Write Dockerfile",
      `mkdir -p /tmp/img && cat > /tmp/img/Dockerfile <<'BBDOCKERFILE'\n${dockerfile}BBDOCKERFILE\ncat /tmp/img/Dockerfile`,
    );
    // --isolation chroot is required: the default tries to create a container
    // namespace, which a microVM refuses with `mount proc to proc: Operation
    // not permitted`, failing every RUN step.
    await stage(
      "Build image",
      `cd /tmp/img && buildah bud --isolation chroot -t ${registryRef} . 2>&1`,
    );
    await stage("Push image", `buildah push ${registryRef} 2>&1 | tail -5`);

    return {
      // A bare repository:tag reference resolves against the authenticated
      // project, which is what Sandbox.create expects.
      imageRef: `${DEFAULT_REPOSITORY}:${tag}`,
      registryRef,
      log,
    };
  } finally {
    // Stopping a sandbox produces a snapshot and deleting the sandbox does not
    // remove it, so a build that only stopped and deleted its VM stranded
    // roughly its own image size in Snapshots Storage every time.
    await deleteSandboxWithSnapshots(sandbox, credentials).catch(() => undefined);
  }
}


// --------------------------------------------------------------- registry

const VERCEL_API = "https://api.vercel.com";

const projectSchema = z.object({ id: z.string() });
const registryImagesSchema = z.object({
  images: z.array(
    z.object({
      id: z.string(),
      tags: z.array(z.string()).nullish(),
      sizeInBytes: z.number().nullish(),
    }),
  ),
});

/** One manifest in the registry repository. */
export interface RegistryImage {
  id: string;
  tags: string[];
  sizeBytes: number;
}

/**
 * Resolved `prj_…` ids, keyed by the slug they came from.
 *
 * The registry API rejects the project *slug* that `inferScope` returns and
 * that the sandboxes API accepts, so every registry call needs this extra
 * lookup. A project's id never changes, so caching it is safe.
 */
const projectIdCache = new Map<string, string>();

async function api(
  credentials: SandboxCredentials,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(`${VERCEL_API}${path}`, {
    ...init,
    headers: {
      ...init.headers,
      authorization: `Bearer ${credentials.token}`,
    },
  });
}

/** Turn the project slug the plugin stores into the id the registry needs. */
export async function resolveProjectId(
  credentials: SandboxCredentials,
): Promise<string> {
  if (credentials.projectId.startsWith("prj_")) return credentials.projectId;
  const cached = projectIdCache.get(credentials.projectId);
  if (cached !== undefined) return cached;

  const response = await api(
    credentials,
    `/v9/projects/${encodeURIComponent(credentials.projectId)}?teamId=${encodeURIComponent(credentials.teamId)}`,
  );
  if (!response.ok) {
    throw new Error(
      `Could not resolve Vercel project "${credentials.projectId}" (${response.status}).`,
    );
  }
  const project = projectSchema.parse(await response.json());
  projectIdCache.set(credentials.projectId, project.id);
  return project.id;
}

/** Every manifest currently in the plugin's registry repository. */
export async function listRegistryImages(
  credentials: SandboxCredentials,
): Promise<RegistryImage[]> {
  const projectId = await resolveProjectId(credentials);
  const response = await api(
    credentials,
    `/v1/vcr/repository/${DEFAULT_REPOSITORY}/images?teamId=${encodeURIComponent(credentials.teamId)}&projectId=${encodeURIComponent(projectId)}`,
  );
  // A repository that does not exist yet simply has no images.
  if (response.status === 404) return [];
  if (!response.ok) {
    throw new Error(`Could not list registry images (${response.status}).`);
  }
  const parsed = registryImagesSchema.parse(await response.json());
  return parsed.images.map((image) => ({
    id: image.id,
    tags: image.tags ?? [],
    sizeBytes: image.sizeInBytes ?? 0,
  }));
}

async function deleteRegistryImage(
  credentials: SandboxCredentials,
  imageId: string,
): Promise<void> {
  const projectId = await resolveProjectId(credentials);
  const response = await api(
    credentials,
    `/v1/vcr/repository/${DEFAULT_REPOSITORY}/images/${encodeURIComponent(imageId)}?teamId=${encodeURIComponent(credentials.teamId)}&projectId=${encodeURIComponent(projectId)}`,
    { method: "DELETE" },
  );
  if (!response.ok && response.status !== 404) {
    throw new Error(`Could not delete image ${imageId} (${response.status}).`);
  }
}

export interface RegistryCleanupResult {
  deleted: string[];
  freedBytes: number;
  failures: string[];
}

/**
 * Delete registry manifests, selected by a predicate.
 *
 * Every failure is collected rather than thrown: registry cleanup is
 * housekeeping, and a manifest that will not delete must not fail the build or
 * the deletion that triggered it.
 */
async function deleteWhere(
  credentials: SandboxCredentials,
  predicate: (image: RegistryImage) => boolean,
): Promise<RegistryCleanupResult> {
  const result: RegistryCleanupResult = {
    deleted: [],
    freedBytes: 0,
    failures: [],
  };
  let images: RegistryImage[];
  try {
    images = await listRegistryImages(credentials);
  } catch (error) {
    result.failures.push(
      error instanceof Error ? error.message : String(error),
    );
    return result;
  }
  for (const image of images.filter(predicate)) {
    try {
      await deleteRegistryImage(credentials, image.id);
      result.deleted.push(image.id);
      result.freedBytes += image.sizeBytes;
    } catch (error) {
      result.failures.push(
        error instanceof Error ? error.message : String(error),
      );
    }
  }
  return result;
}

/**
 * Drop manifests no tag points at.
 *
 * Pushing a tag that already exists leaves the manifest it replaced behind
 * with no tags and its full size, so this runs after every successful build.
 * The repository is plugin-managed and every image it publishes is tagged, so
 * an untagged manifest is always a superseded one.
 */
export function pruneUntaggedImages(
  credentials: SandboxCredentials,
): Promise<RegistryCleanupResult> {
  return deleteWhere(credentials, (image) => image.tags.length === 0);
}

/** Drop the manifest a tag points at, used when an image is deleted. */
export function deleteImagesForTag(
  credentials: SandboxCredentials,
  tag: string,
): Promise<RegistryCleanupResult> {
  return deleteWhere(credentials, (image) => image.tags.includes(tag));
}
