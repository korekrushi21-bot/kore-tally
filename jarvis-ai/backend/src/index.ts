import { assertConfig, config } from './config.js';
import { seedAdmin } from './database/db.js';
import { buildApp } from './app.js';
import { cachedOllama, primaryProvider, resolveAi, getProvider } from './ai/index.js';
import type { OllamaProvider } from './ai/ollama.js';

assertConfig();
seedAdmin();
buildApp().listen(config.port, async () => {
  console.log(`JARVIS backend listening on :${config.port} (put it behind HTTPS)`);
  if (primaryProvider() !== 'ollama') { console.log(`AI provider: ${primaryProvider()} (cloud, optional)`); return; }
  const o = await cachedOllama(true);
  if (o.running && o.models.length) {
    console.log(`Local AI: Ollama ${o.version ?? ''} connected at ${o.baseUrl}; models: ${o.models.map((m) => m.name).join(', ')}`);
    // Pre-load the fast (English) and multilingual (Marathi/Hindi) models so the first reply is not slowed by loading.
    const names = new Set<string>();
    for (const dev of [false, true]) { const r = await resolveAi({ devanagari: dev }); if (r.ok && r.provider === 'ollama') names.add(r.model); }
    for (const m of names) { console.log(`Loading ${m} into memory...`); void (getProvider('ollama') as OllamaProvider).warmUp(m).then(() => console.log(`${m} ready.`)); }
  }
  else if (o.running) console.log('Local AI: Ollama is running but has no model. Run:  ollama pull qwen2.5:3b');
  else if (o.installed) console.log('Local AI: Ollama is installed but not running. Start the Ollama app (or run: ollama serve).');
  else console.log('Local AI: Ollama not found. Install from https://ollama.com/download then run: ollama pull qwen2.5:3b');
});
