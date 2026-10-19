import { config, assertConfig } from './config.js';
import { createApp } from './app.js';
import { disconnectMongo } from './db/connect.js';
import { initDatabase } from './server-init.js';
import { createFirstAdmin } from './services/auth.js';
import { db } from './db/repository.js';


async function main() {
  assertConfig();
  await initDatabase();
  // Premier Super admin créé automatiquement si ADMIN_EMAIL / ADMIN_PASSWORD sont définis et que la base est vide
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD && !(await db().count('users', config.defaultTenant))) {
    await createFirstAdmin({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, name: process.env.ADMIN_NAME || 'Super admin' });
    console.log(`[api] Super admin créé : ${process.env.ADMIN_EMAIL}`);
  }
  const server = createApp().listen(config.port, () => console.log(`[api] CRM Proservices sur http://localhost:${config.port}/api (${config.env}, base : ${config.dbDriver})`));
  const stop = async (sig) => {
    console.log(`[api] arrêt (${sig})`);
    server.close();
    if (config.dbDriver === 'mongo') await disconnectMongo();
    process.exit(0);
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
}

main().catch((e) => { console.error('[api] démarrage impossible :', e.message); process.exit(1); });
