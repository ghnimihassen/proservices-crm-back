/*
 * Import d'un état complet du CRM (sauvegarde JSON du menu « Équipe & paramètres », données du navigateur,
 * ou données de démonstration). Réservé au Super admin.
 *  - mode 'replace' : remplace les données de l'entreprise (les comptes existants sont conservés) ;
 *  - mode 'merge'   : ajoute / met à jour sans rien supprimer.
 * Les membres importés sans mot de passe reçoivent DEMO_PASSWORD (à changer).
 */
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { db, COLLECTIONS, ORDERED } from '../db/repository.js';
import { withPayment } from './ops.js';
import { HttpError, ADMIN_ROLE_ID } from './context.js';
import { CLIENT_ONLY_SETTINGS } from './defaults.js';

const DATA_COLLS = COLLECTIONS.filter((c) => c !== 'users');

export async function importState(ctx, state, { mode = 'replace' } = {}) {
  if (!state || typeof state !== 'object' || !Array.isArray(state.contacts)) throw new HttpError(400, 'Fichier invalide : « contacts » manquant', 'invalid');
  const repo = db(); const t = ctx.tenantId;
  const counts = {};
  const products = new Map((state.catalog || []).map((p) => [p.id, p]));

  for (const coll of DATA_COLLS) {
    if (!Array.isArray(state[coll])) continue;
    let docs = state[coll].filter((d) => d && typeof d.id === 'string');
    if (coll === 'roles') {
      // le rôle Super admin de la base est conservé tel quel
      docs = docs.filter((r) => r.id !== ADMIN_ROLE_ID);
    }
    if (coll === 'contacts') {
      docs = docs.map((c) => withPayment({ ...c, productTypeId: products.get(c.courseId)?.typeId || c.productTypeId || '' }));
    }
    if (ORDERED.includes(coll)) docs = docs.map((d, i) => ({ ...d, _order: i }));
    if (mode === 'replace') {
      if (coll === 'roles') await repo.removeMany('roles', t, { _id: { $ne: ADMIN_ROLE_ID } });
      else await repo.removeMany(coll, t, {});
    }
    for (let i = 0; i < docs.length; i += 500) await repo.bulkUpsert(coll, t, docs.slice(i, i + 500));
    counts[coll] = docs.length;
  }

  // Membres : fusion, sans jamais écraser un compte existant (mot de passe, rôle du Super admin connecté)
  if (Array.isArray(state.users)) {
    const existing = await repo.list('users', t);
    const byEmail = new Map(existing.filter((u) => u.email).map((u) => [u.email, u]));
    const demoHash = await bcrypt.hash(config.demoPassword, 10);
    let n = 0;
    const idMap = {};
    for (const u of state.users) {
      if (!u?.id || !u.name) continue;
      const email = u.email ? String(u.email).trim().toLowerCase() : '';
      const same = existing.find((x) => x.id === u.id) || (email && byEmail.get(email));
      if (same) { idMap[u.id] = same.id; continue; }
      const { password, passwordHash, hasPassword, ...clean } = u;
      await repo.upsert('users', t, { active: true, productTypeIds: [], roleId: 'sales', ...clean, email, passwordHash: demoHash });
      n++;
    }
    // prospects et activités rattachés à un membre fusionné par email
    const remap = Object.entries(idMap).filter(([a, b]) => a !== b);
    for (const [from, to] of remap) {
      for (const [coll, field] of [['contacts', 'ownerId'], ['appointments', 'ownerId'], ['tasks', 'ownerId'], ['activities', 'userId']]) {
        const docs = await repo.list(coll, t, { [field]: from });
        if (docs.length) await repo.bulkUpsert(coll, t, docs.map((d) => ({ ...d, [field]: to })));
      }
    }
    counts.users = n;
  }

  if (state.company && typeof state.company === 'object') await repo.setSingleton('company', t, state.company);
  if (state.settings && typeof state.settings === 'object') {
    const s = { ...state.settings }; CLIENT_ONLY_SETTINGS.forEach((k) => delete s[k]);
    await repo.setSingleton('settings', t, { ...(await repo.getSingleton('settings', t)), ...s });
  }
  return counts;
}
