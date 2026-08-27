// Agent providers a template can hold credentials for.
//
// These are secrets, not build-time variables: they are injected into a
// machine's environment when it is created, so they never enter an image
// layer that anyone able to pull the image could read.
//
// Like machines.ts and images.ts this module carries no bb dependency.

/** One credential an agent provider reads from the environment. */
export interface AgentCredential {
  /** Environment variable name, and the key the secret is stored under. */
  key: string;
  /** What the credential is for, in the provider's own terms. */
  label: string;
}

export interface AgentProvider {
  id: string;
  label: string;
  description: string;
  /** Shown above the fields; where to get the credentials. */
  hint: string;
  credentials: AgentCredential[];
}

export const AGENT_PROVIDERS: AgentProvider[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    description: "Anthropic's coding agent.",
    hint: "Run `claude setup-token` on your own machine for a long-lived OAuth token.",
    credentials: [
      { key: "CLAUDE_CODE_OAUTH_TOKEN", label: "OAuth token" },
    ],
  },
  {
    id: "pi",
    label: "pi.dev",
    description: "The pi coding agent.",
    // pi resolves a provider's key from the matching environment variable.
    // https://pi.dev/docs/latest/providers#environment-variables-or-auth-file
    hint: "pi reads each provider's key from its own environment variable. Fill in only the providers you use.",
    credentials: [
      { key: "ANTHROPIC_API_KEY", label: "Anthropic" },
      { key: "OPENAI_API_KEY", label: "OpenAI" },
      { key: "GEMINI_API_KEY", label: "Google Gemini" },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter" },
      { key: "GROQ_API_KEY", label: "Groq" },
      { key: "DEEPSEEK_API_KEY", label: "DeepSeek" },
      { key: "MISTRAL_API_KEY", label: "Mistral" },
      { key: "TOGETHER_API_KEY", label: "Together" },
      { key: "CEREBRAS_API_KEY", label: "Cerebras" },
      { key: "FIREWORKS_API_KEY", label: "Fireworks" },
      { key: "BASETEN_API_KEY", label: "Baseten" },
      { key: "NVIDIA_API_KEY", label: "NVIDIA" },
      { key: "KIMI_API_KEY", label: "Kimi" },
      { key: "MINIMAX_API_KEY", label: "MiniMax" },
      { key: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI" },
      { key: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway" },
    ],
  },
];

/** Every key any provider recognises, for validating what may be stored. */
export function isKnownCredentialKey(key: string): boolean {
  return AGENT_PROVIDERS.some((provider) =>
    provider.credentials.some((credential) => credential.key === key),
  );
}
