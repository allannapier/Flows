// App-level configuration (currently just the validator LLM), persisted at
// `$FLOWS_HOME/config.json` — a sibling of the `flows/` directory used by
// storage.ts. Same FLOWS_HOME resolution as storage.ts (defaults to
// ~/.flows).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ValidatorProvider = "anthropic" | "openai" | "google" | "custom";

export interface ValidatorConfig {
  provider: ValidatorProvider;
  /** Required for non-anthropic providers; anthropic falls back to a default. */
  model?: string;
  /** Optional; falls back to a provider-specific environment variable. */
  apiKey?: string;
  /** Only meaningful for the "custom" (OpenAI-compatible) provider. */
  baseUrl?: string;
}

export interface AppConfig {
  validator: ValidatorConfig;
}

export const PROVIDER_LABELS: Record<ValidatorProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  custom: "Custom (OpenAI-compatible)",
};

export const PROVIDER_ENV_VAR: Record<ValidatorProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  custom: "OPENAI_API_KEY",
};

const DEFAULT_ANTHROPIC_MODEL = "claude-opus-4-8";

function defaultConfig(): AppConfig {
  return { validator: { provider: "anthropic" } };
}

function flowsHome(): string {
  return process.env.FLOWS_HOME ?? path.join(os.homedir(), ".flows");
}

function configPath(): string {
  return path.join(flowsHome(), "config.json");
}

/** Loads `$FLOWS_HOME/config.json`. Missing or corrupt files fall back to
 * defaults rather than throwing — configuration is optional. */
export function loadConfig(): AppConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<AppConfig>;
    if (!parsed || typeof parsed !== "object" || !parsed.validator) {
      return defaultConfig();
    }
    return {
      validator: {
        provider: parsed.validator.provider ?? "anthropic",
        model: parsed.validator.model,
        apiKey: parsed.validator.apiKey,
        baseUrl: parsed.validator.baseUrl,
      },
    };
  } catch {
    return defaultConfig();
  }
}

/** Writes `$FLOWS_HOME/config.json`, pretty-printed and restricted to
 * owner read/write (0600) — it may contain an API key. The mode is set both
 * at write time and via an explicit chmod afterward, in case the file
 * already existed with looser permissions. */
export function saveConfig(config: AppConfig): void {
  const home = flowsHome();
  fs.mkdirSync(home, { recursive: true });
  const p = configPath();
  fs.writeFileSync(p, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(p, 0o600);
}

/** Masks an API key for display: "••••" + last 4 characters, or "(not set)"
 * when empty/undefined. */
export function maskKey(key: string | undefined): string {
  if (!key || key.trim() === "") return "(not set)";
  const trimmed = key.trim();
  if (trimmed.length <= 4) return `••••${trimmed}`;
  return `••••${trimmed.slice(-4)}`;
}

export interface ResolvedValidator {
  provider: ValidatorProvider;
  model: string;
  apiKey: string;
  /** Which env var supplied the key, when it wasn't set in config — lets the
   * caller distinguish ANTHROPIC_AUTH_TOKEN from ANTHROPIC_API_KEY. */
  apiKeyEnvVar?: string;
  baseUrl?: string;
}

/** Resolves the effective validator settings from config, falling back to
 * environment variables where the config leaves a field unset. Throws a
 * user-facing Error (mentioning the Settings screen) when a required field
 * is missing everywhere. */
export function resolveValidator(config?: AppConfig): ResolvedValidator {
  const cfg = (config ?? loadConfig()).validator;
  const provider = cfg.provider ?? "anthropic";

  let model = cfg.model;
  if (!model) {
    if (provider === "anthropic") {
      model = process.env.FLOWS_VALIDATOR_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    } else {
      throw new Error(
        `Validator model not set — open Settings (s) and set a model for ${PROVIDER_LABELS[provider]}`,
      );
    }
  }

  let apiKey = cfg.apiKey;
  let apiKeyEnvVar: string | undefined;
  if (!apiKey) {
    if (provider === "anthropic") {
      if (process.env.ANTHROPIC_API_KEY) {
        apiKey = process.env.ANTHROPIC_API_KEY;
        apiKeyEnvVar = "ANTHROPIC_API_KEY";
      } else if (process.env.ANTHROPIC_AUTH_TOKEN) {
        apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
        apiKeyEnvVar = "ANTHROPIC_AUTH_TOKEN";
      }
    } else if (provider === "openai" || provider === "custom") {
      if (process.env.OPENAI_API_KEY) {
        apiKey = process.env.OPENAI_API_KEY;
        apiKeyEnvVar = "OPENAI_API_KEY";
      }
    } else if (provider === "google") {
      if (process.env.GEMINI_API_KEY) {
        apiKey = process.env.GEMINI_API_KEY;
        apiKeyEnvVar = "GEMINI_API_KEY";
      } else if (process.env.GOOGLE_API_KEY) {
        apiKey = process.env.GOOGLE_API_KEY;
        apiKeyEnvVar = "GOOGLE_API_KEY";
      }
    }
  }
  if (!apiKey) {
    throw new Error(
      `No API key for ${PROVIDER_LABELS[provider]} — set one in Settings (s) or export ${PROVIDER_ENV_VAR[provider]}`,
    );
  }

  let baseUrl = cfg.baseUrl;
  if (provider === "custom" && !baseUrl) {
    throw new Error(
      `No base URL for ${PROVIDER_LABELS[provider]} — set one in Settings (s)`,
    );
  }

  return { provider, model, apiKey, apiKeyEnvVar, baseUrl };
}
