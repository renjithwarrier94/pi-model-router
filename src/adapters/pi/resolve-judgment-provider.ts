import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgmentProvider } from "../../application/ports/judgment-provider.js";
import { JudgmentProviderError } from "../../application/ports/judgment-provider.js";
import { JevJudgmentProvider, type JevJudgmentProviderConfig } from "../typesafe/jev-judgment-provider.js";

export interface JudgmentBackend {
  readonly provider: JudgmentProvider;
  readonly recipient: "OpenRouter" | "TypeSafe";
}

type ProviderFactory = (config: JevJudgmentProviderConfig) => JudgmentProvider;
const createProvider: ProviderFactory = config => new JevJudgmentProvider(config);
const nonempty = (value: string | undefined): string | undefined => value?.trim() || undefined;

/** Resolve credentials at the Pi boundary. Never read auth.json or place secrets in router config. */
export async function resolveJudgmentBackend(
  ctx: ExtensionContext,
  env: Readonly<Record<string, string | undefined>> = process.env,
  makeProvider: ProviderFactory = createProvider,
): Promise<JudgmentBackend> {
  let piKey: string | undefined;
  try {
    piKey = nonempty(await ctx.modelRegistry.getApiKeyForProvider("openrouter"));
  } catch {
    // Some providers cannot resolve credentials; explicit env keys may still work.
  }
  const openRouterKey = piKey ?? nonempty(env.OPENROUTER_API_KEY);
  if (openRouterKey) return {
    recipient: "OpenRouter",
    provider: makeProvider({ apiKey: openRouterKey, baseURL: "https://openrouter.ai/api", defaultModel: "jev-1.13" }),
  };
  const typeSafeKey = nonempty(env.TYPESAFE_API_KEY);
  if (typeSafeKey) return {
    recipient: "TypeSafe",
    // Explicit URL/model prevents unrelated SDK environment settings redirecting private context.
    provider: makeProvider({ apiKey: typeSafeKey, baseURL: "https://api.typesafe.ai", defaultModel: "jev-latest" }),
  };
  throw new JudgmentProviderError("unauthorized", "No judgment-provider API key is available.");
}
