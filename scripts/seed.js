/*
 * Initialise la base : données de base de l'entreprise + premier Super admin.
 *   ADMIN_EMAIL=moi@entreprise.tn ADMIN_PASSWORD=motdepasse npm run seed
 * Options : --tenant=<id> (par défaut DEFAULT_TENANT)
 * Pour charger les données de démonstration, connectez-vous puis « Équipe & paramètres → Charger la démo ».
 */
import { config, assertConfig } from '../src/config.js';
import { initDatabase } from '../src/server-init.js';
import { createFirstAdmin } from '../src/services/auth.js';
import { ensureTenant } from '../src/services/context.js';
import { db } from '../src/db/repository.js';
import { disconnectMongo } from '../src/db/connect.js';

const arg = (k) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=')[1];
const tenantId = arg('tenant') || config.defaultTenant;

assertConfig();
await initDatabase();
await ensureTenant(tenantId);
if (await db().count('users', tenantId)) {
  console.log(`[seed] L'entreprise « ${tenantId} » a déjà des membres : rien à faire.`);
} else {
  const email = process.env.ADMIN_EMAIL; const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) { console.error('[seed] Définissez ADMIN_EMAIL et ADMIN_PASSWORD (8 caractères minimum).'); process.exit(1); }
  await createFirstAdmin({ tenantId, email, password, name: process.env.ADMIN_NAME || 'Super admin' });
  console.log(`[seed] Super admin créé : ${email} (entreprise « ${tenantId} »)`);
}
if (config.dbDriver === 'mongo') await disconnectMongo();
