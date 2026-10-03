import { config } from '../config.js';
import { getSetting } from '../database/db.js';
import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider, ollamaStatus, pickModel, type OllamaStatus } from './ollama.js';
import { OpenAIProvider } from './openai.js';
import type { AIProvider } from './types.js';

export type ProviderName = 'ollama' | 'openai' | 'anthropic' | 'custom';
const isName = (s: unknown): s is ProviderName => s === 'ollama' || s === 'openai' || s === 'anthropic' || s === 'custom';

/** Cloud providers are optional and paid/free-tier depending on the vendor. They are never required. */
export function cloudConfigured(p: Exclude<ProviderName, 'ollama'>) {
  return p === 'anthropic' ? !!config.anthropicApiKey : p === 'custom' ? !!config.aiBaseUrl : !!config.aiApiKey;
}

export function primaryProvider(requested?: string): ProviderName {
  if (isName(requested) && (requested === 'ollama' || cloudConfigured(requested))) return requested;
  const stored = getSetting('ai.provider');
  return isName(stored) ? stored : config.provider;
}

export function getProvider(name: ProviderName): AIProvider {
  switch (name) {
    case 'ollama': return new OllamaProvider(config.ollamaBaseUrl);
    case 'anthropic': return new AnthropicProvider(config.anthropicApiKey);
    case 'custom': return new OpenAIProvider('custom', config.aiApiKey, config.aiBaseUrl.replace(/\/+$/, ''));
    default: return new OpenAIProvider('openai', config.aiApiKey);
  }
}

const CLOUD_DEFAULT_MODEL = { openai: 'gpt-4o-mini', anthropic: 'claude-sonnet-5-5', custom: 'default' } as const;

export type Resolved =
  | { ok: true; provider: ProviderName; model: string; vision: boolean; usedFallback: boolean }
  | { ok: false; reason: 'ollama_not_running' | 'ollama_no_model' | 'cloud_not_configured'; status?: OllamaStatus };

let cache: { at: number; s: OllamaStatus } | null = null;
export async function cachedOllama(force = false): Promise<OllamaStatus> {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.s;
  const s = await ollamaStatus(config.ollamaBaseUrl);
  cache = { at: Date.now(), s };
  return s;
}

/** Decide which provider/model actually serves a request. Local Ollama first; optional cloud fallback if configured. */
export async function resolveAi(requested?: { provider?: string; model?: string; devanagari?: boolean }, needVision = false): Promise<Resolved> {
  const provider = primaryProvider(requested?.provider);
  const wantedModel = requested?.model?.trim() || getSetting('ai.model') || config.aiModel || undefined;

  if (provider === 'ollama') {
    const st = await cachedOllama();
    if (st.running) {
      const pool = needVision ? st.models.filter((m) => m.vision) : st.models;
      const model = pickModel(pool, needVision ? config.visionModel || wantedModel : wantedModel, !!requested?.devanagari);
      if (model) return { ok: true, provider, model, vision: st.models.find((m) => m.name === model)?.vision ?? false, usedFallback: false };
    }
    const fb = config.fallbackProvider;
    if (fb && cloudConfigured(fb)) {
      return { ok: true, provider: fb, model: config.aiModel || CLOUD_DEFAULT_MODEL[fb], vision: true, usedFallback: true };
    }
    return { ok: false, reason: st.running ? 'ollama_no_model' : 'ollama_not_running', status: st };
  }
  if (!cloudConfigured(provider)) return { ok: false, reason: 'cloud_not_configured' };
  return { ok: true, provider, model: wantedModel || CLOUD_DEFAULT_MODEL[provider], vision: true, usedFallback: false };
}
