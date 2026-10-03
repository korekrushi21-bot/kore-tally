import 'dotenv/config';

const env = process.env;

export const config = {
  port: Number(env.PORT ?? 8787),
  /** Shared secret users type once into the app (Settings → AI). Exchanged for a short-lived JWT. */
  accessCode: env.APP_ACCESS_CODE ?? '',
  jwtSecret: env.JWT_SECRET ?? '',
  adminUsername: env.ADMIN_USERNAME ?? 'admin',
  adminPasswordHash: env.ADMIN_PASSWORD_HASH ?? '',
  dbPath: env.DATABASE_PATH ?? './data/jarvis.db',

  /** Default is local AI (Ollama): no API key and no cost. Cloud providers are optional. */
  provider: (env.AI_PROVIDER ?? 'ollama') as 'ollama' | 'openai' | 'anthropic' | 'custom',
  ollamaBaseUrl: env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
  /** Optional: used only if Ollama is unreachable/has no model. */
  fallbackProvider: (env.AI_FALLBACK_PROVIDER ?? '') as '' | 'openai' | 'anthropic' | 'custom',
  aiApiKey: env.AI_API_KEY ?? '',
  aiModel: env.AI_MODEL ?? '',
  aiBaseUrl: env.AI_BASE_URL ?? '', // custom / OpenAI-compatible provider
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? env.AI_API_KEY ?? '',
  visionModel: env.VISION_MODEL ?? '',

  searchApiKey: env.SEARCH_API_KEY ?? '', // Tavily (optional, has a free tier)
  /** Read-only PC access (files/system info). Folders separated by ; (default Desktop, Documents, Downloads). */
  pcReadEnabled: (env.PC_READ_ENABLED ?? 'true').toLowerCase() !== 'false',
  pcReadFolders: (env.PC_READ_FOLDERS ?? '').split(';').map((s) => s.trim()).filter(Boolean),
  searxngUrl: (env.SEARXNG_URL ?? '').replace(/\/+$/, ''), // optional self-hosted metasearch (free)
  ttsApiKey: env.TTS_API_KEY ?? '',       // reserved: cloud TTS (optional)
  sttApiKey: env.STT_API_KEY ?? '',       // reserved: cloud STT (optional)

  corsOrigins: (env.CORS_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  isProd: env.NODE_ENV === 'production',
};

export function assertConfig() {
  const problems: string[] = [];
  if (config.jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');
  if (!config.accessCode || config.accessCode.length < 8) problems.push('APP_ACCESS_CODE must be set (8+ chars)');
  if (problems.length) throw new Error('Invalid configuration:\n - ' + problems.join('\n - '));
}
