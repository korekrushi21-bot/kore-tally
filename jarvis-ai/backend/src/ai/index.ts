import { config, DEFAULT_MODELS } from '../config.js';
import { getSetting } from '../database/db.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import type { AIProvider } from './types.js';

export type ProviderName = 'openai' | 'anthropic' | 'custom';
const isName = (s: unknown): s is ProviderName => s === 'openai' || s === 'anthropic' || s === 'custom';

/** Effective AI config: admin override (DB) > env. Keys never leave the server. */
export function activeConfig(requested?: { provider?: string; model?: string }) {
  const provider: ProviderName = isName(requested?.provider) && providerConfigured(requested!.provider as ProviderName)
    ? (requested!.provider as ProviderName)
    : isName(getSetting('ai.provider')) ? (getSetting('ai.provider') as ProviderName) : config.provider;
  const model = requested?.model?.trim() || getSetting('ai.model') || config.aiModel || DEFAULT_MODELS[provider];
  return { provider, model };
}

export function providerConfigured(p: ProviderName) {
  return p === 'anthropic' ? !!config.anthropicApiKey : p === 'custom' ? !!config.aiApiKey && !!config.aiBaseUrl : !!config.aiApiKey;
}

export function getProvider(name: ProviderName): AIProvider {
  switch (name) {
    case 'anthropic': return new AnthropicProvider(config.anthropicApiKey);
    case 'custom': return new OpenAIProvider('custom', config.aiApiKey, config.aiBaseUrl.replace(/\/+$/, ''));
    default: return new OpenAIProvider('openai', config.aiApiKey);
  }
}
