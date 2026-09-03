// Agent providers a template can hold credentials for.
//
// These are secrets, not build-time variables: they are injected into a
// machine's environment when it is created, so they never enter an image
// layer that anyone able to pull the image could read.
//
// Like machines.ts and templates.ts this module carries no bb dependency.

/** One value an agent provider reads from the environment. */
export interface AgentCredential {
  /** Environment variable name, and the key the value is stored under. */
  key: string;
  /** What the value is for, in the provider's own terms. */
  label: string;
  /**
   * Whether the value is a credential. Secret values are write-only: they are
   * never returned once stored, so the field can only be replaced or cleared.
   * A false here is for the ordinary configuration a provider needs alongside
   * its credentials — a name, an email — which is unhelpful to hide.
   */
  secret: boolean;
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
      { key: "CLAUDE_CODE_OAUTH_TOKEN", label: "OAuth token", secret: true },
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
      { key: "ANTHROPIC_API_KEY", label: "Anthropic", secret: true },
      { key: "OPENAI_API_KEY", label: "OpenAI", secret: true },
      { key: "GEMINI_API_KEY", label: "Google Gemini", secret: true },
      { key: "OPENROUTER_API_KEY", label: "OpenRouter", secret: true },
      { key: "GROQ_API_KEY", label: "Groq", secret: true },
      { key: "DEEPSEEK_API_KEY", label: "DeepSeek", secret: true },
      { key: "MISTRAL_API_KEY", label: "Mistral", secret: true },
      { key: "TOGETHER_API_KEY", label: "Together", secret: true },
      { key: "CEREBRAS_API_KEY", label: "Cerebras", secret: true },
      { key: "FIREWORKS_API_KEY", label: "Fireworks", secret: true },
      { key: "BASETEN_API_KEY", label: "Baseten", secret: true },
      { key: "NVIDIA_API_KEY", label: "NVIDIA", secret: true },
      { key: "KIMI_API_KEY", label: "Kimi", secret: true },
      { key: "MINIMAX_API_KEY", label: "MiniMax", secret: true },
      { key: "AZURE_OPENAI_API_KEY", label: "Azure OpenAI", secret: true },
      { key: "AI_GATEWAY_API_KEY", label: "Vercel AI Gateway", secret: true },
    ],
  },
];
