// Thread machines: Vercel Sandboxes bb creates for a thread when a Cloud
// Machine entry is chosen in the environment picker.
//
// Unlike the machines on the Vercel Sandboxes page, bb owns these: it decides
// when one is created, suspended and removed, and enrolls each one itself
// through the executor below. The provider is ephemeral, so a machine made for
// a thread is never offered in the picker as a place to put another thread.
import type { BbPluginApi, MachineExecutor } from "@get-bb/plugin-sdk";
import type { Sandbox } from "@vercel/sandbox";
import { z } from "zod";
import {
  deleteSandboxWithSnapshots,
  describeSandboxError,
  execInSandbox,
  findSandbox,
  openThreadMachine,
  PREREQUISITES_SCRIPT,
  threadMachineName,
  type SandboxCredentials,
} from "./machines.js";

/** The entry for Vercel's default image; each built template adds its own. */
export const THREAD_MACHINE_PROVIDER_ID = "cloud-sandbox";
const PREREQUISITES_TIMEOUT_MS = 20 * 60_000;
const DISPLAY_NAME_MAX_CHARS = 80;
const DESCRIPTION_MAX_CHARS = 200;

const resourceSchema = z.object({
  key: z.string(),
  sandboxName: z.string(),
  templateId: z.string().nullable(),
});
export type ThreadMachineResource = z.infer<typeof resourceSchema>;

/** True for the machine providers this module registers. */
export function isThreadMachineProvider(
  machineProviderId: string | null,
): boolean {
  return (
    machineProviderId === THREAD_MACHINE_PROVIDER_ID ||
    (machineProviderId?.startsWith(`${THREAD_MACHINE_PROVIDER_ID}-`) ?? false)
  );
}

/**
 * The sandbox a bb machine belongs to, or null when the machine has no
 * resource yet or one this plugin no longer understands.
 */
export function parseThreadMachineResource(
  stored: unknown,
): ThreadMachineResource | null {
  const parsed = resourceSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export interface ThreadMachineTemplate {
  name: string;
  imageRef: string | null;
}

export interface ThreadMachineDeps {
  credentials(): Promise<SandboxCredentials | null>;
  limits(): Promise<{ timeoutMs: number; vcpus: number }>;
  machineEnv(templateId: string | null): Promise<Record<string, string>>;
  template(id: string): ThreadMachineTemplate | null;
}

function providerId(templateId: string | null): string {
  return templateId === null
    ? THREAD_MACHINE_PROVIDER_ID
    : `${THREAD_MACHINE_PROVIDER_ID}-${templateId}`;
}

function errorMessage(error: unknown): string {
  const failure = describeSandboxError(error);
  return failure.status === null
    ? failure.message
    : `[${failure.status}] ${failure.message}`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function sandboxExecutor(sandbox: Sandbox): MachineExecutor {
  return {
    async exec(request) {
      return { exitCode: await execInSandbox(sandbox, request) };
    },
  };
}

/**
 * Offer one Cloud Machine entry in the environment picker: a composed
 * environment that creates a machine from this provider and checks the
 * project out on it.
 *
 * A composed environment always launches its machine with null inputs, so the
 * template cannot travel as a machine input; it is bound into the provider
 * instead, one provider per template. Registering an id again replaces it,
 * which is how a renamed template updates its entry.
 */
export function registerThreadMachine(
  bb: BbPluginApi,
  deps: ThreadMachineDeps,
  templateId: string | null,
): void {
  const id = providerId(templateId);
  const current = templateId === null ? null : deps.template(templateId);
  const displayName = truncate(
    current === null ? "Cloud Machine" : `Cloud Machine · ${current.name}`,
    DISPLAY_NAME_MAX_CHARS,
  );
  const source =
    current === null
      ? "Vercel's default image"
      : `the "${current.name}" template`;

  async function requireCredentials(): Promise<SandboxCredentials> {
    const credentials = await deps.credentials();
    if (credentials === null) {
      throw new Error(
        "Not signed in to Vercel. Use Sign in with Vercel on the Vercel Sandboxes settings page.",
      );
    }
    return credentials;
  }

  /** The template to boot from, re-read so a deleted one refuses to launch. */
  function requireTemplate(): { name: string; imageRef: string } | null {
    if (templateId === null) return null;
    const template = deps.template(templateId);
    if (template === null) throw new Error("This template has been deleted.");
    if (template.imageRef === null) {
      throw new Error(`Template "${template.name}" has not been built.`);
    }
    return { name: template.name, imageRef: template.imageRef };
  }

  bb.experimental_environments.register({
    id,
    displayName,
    description: truncate(
      `Check the project out on a new Vercel sandbox from ${source}.`,
      DESCRIPTION_MAX_CHARS,
    ),
    icon: "Cloud",
    machineProviderId: id,
    environmentProviderId: "project-checkout",
  });

  bb.experimental_machines.register({
    id,
    displayName,
    description: truncate(
      `Create a Vercel sandbox from ${source}.`,
      DESCRIPTION_MAX_CHARS,
    ),
    icon: "Cloud",
    ephemeral: true,
    async availability() {
      if ((await deps.credentials()) === null) {
        return {
          status: "setup-required",
          message: "Sign in with Vercel on the Vercel Sandboxes settings page.",
        };
      }
      try {
        requireTemplate();
        return { status: "available" };
      } catch (error) {
        return { status: "unavailable", message: errorMessage(error) };
      }
    },
    async create(context) {
      try {
        const credentials = await requireCredentials();
        const template = requireTemplate();
        const { timeoutMs, vcpus } = await deps.limits();
        const resource: ThreadMachineResource = {
          key: context.key,
          sandboxName: threadMachineName(context.key),
          templateId,
        };
        context.report.step(`Creating a Vercel sandbox from ${source}…`);
        const sandbox = await openThreadMachine({
          credentials,
          name: resource.sandboxName,
          env: await deps.machineEnv(templateId),
          ...(template === null ? {} : { image: template.imageRef }),
          timeoutMs,
          vcpus,
          signal: context.signal,
        });
        await context.checkpoint(resource);
        context.report.step("Installing bb's prerequisites…");
        const exitCode = await execInSandbox(sandbox, {
          command: ["bash", "-lc", PREREQUISITES_SCRIPT],
          stdin: "",
          timeoutMs: Math.min(timeoutMs, PREREQUISITES_TIMEOUT_MS),
          signal: context.signal,
          onOutput: (chunk) => context.report.log(chunk),
        });
        if (exitCode !== 0) {
          throw new Error(`Installing bb's prerequisites failed (exit ${exitCode}).`);
        }
        const { hostId } = await bb.experimental_machines.bootstrap({
          key: context.key,
          executor: sandboxExecutor(sandbox),
          report: context.report,
          signal: context.signal,
        });
        const suffix = hostId.replace(/[^a-z0-9]/giu, "").slice(-6);
        return {
          status: "created",
          name: truncate(
            `${template?.name ?? "Cloud"} sandbox ${suffix}`,
            DISPLAY_NAME_MAX_CHARS,
          ),
          resource,
        };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async reconcileCleanup(context) {
      try {
        const credentials = await requireCredentials();
        const sandbox = await findSandbox(
          credentials,
          threadMachineName(context.key),
          { signal: context.signal },
        );
        if (sandbox !== null) await deleteSandboxWithSnapshots(sandbox, credentials);
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
    async suspend(context) {
      const resource = resourceSchema.parse(context.resource);
      const sandbox = await findSandbox(
        await requireCredentials(),
        resource.sandboxName,
        { signal: context.signal },
      );
      if (sandbox === null) {
        throw new Error(`Sandbox ${resource.sandboxName} no longer exists.`);
      }
      context.report.step("Stopping the Vercel sandbox…");
      await sandbox.stop();
      return { resource };
    },
    async resume(context) {
      const resource = resourceSchema.parse(context.resource);
      context.report.step("Resuming the Vercel sandbox…");
      const sandbox = await findSandbox(
        await requireCredentials(),
        resource.sandboxName,
        { resume: true, signal: context.signal },
      );
      if (sandbox === null) {
        throw new Error(`Sandbox ${resource.sandboxName} no longer exists.`);
      }
      await bb.experimental_machines.bootstrap({
        key: resource.key,
        executor: sandboxExecutor(sandbox),
        report: context.report,
        signal: context.signal,
      });
      return { resource };
    },
    async remove(context) {
      try {
        const resource = resourceSchema.parse(context.resource);
        const credentials = await requireCredentials();
        const sandbox = await findSandbox(credentials, resource.sandboxName, {
          signal: context.signal,
        });
        if (sandbox !== null) await deleteSandboxWithSnapshots(sandbox, credentials);
        return { status: "removed" };
      } catch (error) {
        context.signal.throwIfAborted();
        return { status: "failed", message: errorMessage(error) };
      }
    },
  });
}
