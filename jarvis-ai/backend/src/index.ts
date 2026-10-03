import { assertConfig, config } from './config.js';
import { seedAdmin } from './database/db.js';
import { buildApp } from './app.js';
import { cachedOllama, primaryProvider } from './ai/index.js';

assertConfig();
seedAdmin();
buildApp().listen(config.port, async () => {
  console.log(`JARVIS backend listening on :${config.port} (put it behind HTTPS)`);
  if (primaryProvider() !== 'ollama') { console.log(`AI provider: ${primaryProvider()} (cloud, optional)`); return; }
  const o = await cachedOllama(true);
  if (o.running && o.models.length) console.log(`Local AI: Ollama ${o.version ?? ''} connected at ${o.baseUrl}; models: ${o.models.map((m) => m.name).join(', ')}`);
  else if (o.running) console.log('Local AI: Ollama is running but has no model. Run:  ollama pull qwen2.5:3b');
  else if (o.installed) console.log('Local AI: Ollama is installed but not running. Start the Ollama app (or run: ollama serve).');
  else console.log('Local AI: Ollama not found. Install from https://ollama.com/download then run: ollama pull qwen2.5:3b');
});
