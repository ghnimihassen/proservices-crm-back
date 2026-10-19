/* Contexte de la requête : utilisateur connecté, ses droits et son périmètre */
import { db } from '../db/repository.js';
import { can, allowedTypeIds, isSuperAdmin, ADMIN_ROLE_ID } from '../shared/permissions.js';
import { defaultRoles, DEFAULT_STAGES, defaultClauses, DEFAULT_COMPANY, DEFAULT_SETTINGS } from './defaults.js';

export class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
export const forbidden = (msg = 'Action non autorisée pour votre rôle') => new HttpError(403, msg, 'forbidden');

/** Crée les données de base d'une entreprise au premier accès (rôles, étapes, conditions, profil, paramètres) */
export async function ensureTenant(tenantId) {
  const repo = db();
  if (await repo.count('roles', tenantId)) return false;
  await repo.bulkUpsert('roles', tenantId, defaultRoles());
  if (!(await repo.count('stages', tenantId))) await repo.bulkUpsert('stages', tenantId, DEFAULT_STAGES.map((s, i) => ({ ...s, _order: i })));
  if (!(await repo.count('clauses', tenantId))) await repo.bulkUpsert('clauses', tenantId, defaultClauses().map((c, i) => ({ ...c, _order: i })));
  if (!(await repo.getSingleton('company', tenantId))) await repo.setSingleton('company', tenantId, DEFAULT_COMPANY);
  if (!(await repo.getSingleton('settings', tenantId))) await repo.setSingleton('settings', tenantId, DEFAULT_SETTINGS);
  return true;
}

/** État minimal attendu par les fonctions partagées can(), allowedTypeIds()… */
export async function buildContext(tenantId, user) {
  const repo = db();
  const [roles, productTypes] = await Promise.all([repo.list('roles', tenantId), repo.list('productTypes', tenantId)]);
  const state = { roles, productTypes, users: [user], settings: { currentUserId: user.id } };
  const ctx = {
    tenantId, user, roles, productTypes, state,
    can: (key) => can(state, key, user),
    isAdmin: () => isSuperAdmin(state, user),
    allowedTypes: () => allowedTypeIds(state, user), // null = toutes les activités
  };
  return ctx;
}

export { ADMIN_ROLE_ID };

export const publicUser = (u) => {
  if (!u) return u;
  const { passwordHash, password, ...rest } = u;
  return { ...rest, hasPassword: !!passwordHash };
};
