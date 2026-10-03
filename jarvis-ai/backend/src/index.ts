import { assertConfig, config } from './config.js';
import { seedAdmin } from './database/db.js';
import { buildApp } from './app.js';

assertConfig();
seedAdmin();
buildApp().listen(config.port, () => console.log(`JARVIS backend listening on :${config.port} (put it behind HTTPS)`));
