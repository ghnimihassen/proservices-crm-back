import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { db } from '../db/repository.js';
import { HttpError, ensureTenant, publicUser, ADMIN_ROLE_ID } from './context.js';

const DUMMY_HASH = bcrypt.hashSync('timing-protection', 10);

export const signToken = (user, tenantId) => jwt.sign({ sub: user.id, tid: tenantId }, config.jwtSecret, { expiresIn: config.jwtExpiresIn });

export function verifyToken(token) {
  try { return jwt.verify(token, config.jwtSecret); } catch { throw new HttpError(401, 'Session expirée ou invalide, reconnectez-vous', 'unauthorized'); }
}

export async function login({ email, password, tenantId = config.defaultTenant }) {
  const repo = db();
  const [user] = await repo.list('users', tenantId, { email: String(email || '').trim().toLowerCase() });
  // même message et même durée que le compte existe ou non
  const ok = user?.passwordHash ? await bcrypt.compare(String(password || ''), user.passwordHash) : (await bcrypt.compare('x', DUMMY_HASH), false);
  if (!ok) throw new HttpError(401, 'Email ou mot de passe incorrect', 'bad_credentials');
  if (user.active === false) throw new HttpError(403, 'Compte désactivé, contactez un Super admin', 'disabled');
  await repo.upsert('users', tenantId, { ...user, lastLoginAt: new Date().toISOString() });
  return { token: signToken(user, tenantId), user: publicUser(user), tenantId };
}

/**
 * Première installation : crée le Super admin si l'entreprise n'a encore aucun membre.
 * Utilisé par `npm run seed` et par POST /api/auth/setup (désactivé dès qu'un membre existe).
 */
export async function createFirstAdmin({ tenantId = config.defaultTenant, name, email, password }) {
  const repo = db();
  await ensureTenant(tenantId);
  if (await repo.count('users', tenantId)) throw new HttpError(409, 'L’installation est déjà faite : connectez-vous', 'already_setup');
  if (!email || !password || String(password).length < 8) throw new HttpError(400, 'Email et mot de passe (8 caractères minimum) obligatoires', 'invalid');
  const user = { id: crypto.randomUUID(), name: name || 'Super admin', email: String(email).trim().toLowerCase(), role: 'Direction', roleId: ADMIN_ROLE_ID, active: true, productTypeIds: [], passwordHash: await bcrypt.hash(String(password), 10) };
  await repo.upsert('users', tenantId, user);
  return { token: signToken(user, tenantId), user: publicUser(user), tenantId };
}

/**
 * Connexion unique (SSO) depuis VOTRE backend : il appelle POST /api/auth/sso avec l'en-tête
 * `x-sso-secret: <SSO_SECRET>` et l'utilisateur déjà authentifié chez vous. Le membre est créé ou mis à jour
 * et un jeton CRM est renvoyé, à passer au composant React (prop `token`).
 */
export async function ssoLogin({ secret, tenantId = config.defaultTenant, externalId, email, name, phone, role, roleId, productTypeIds }) {
  if (!config.ssoSecret) throw new HttpError(404, 'SSO non configuré (SSO_SECRET)', 'sso_disabled');
  const a = Buffer.from(String(secret || '')); const b = Buffer.from(config.ssoSecret);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new HttpError(401, 'Secret SSO invalide', 'unauthorized');
  if (!email && !externalId) throw new HttpError(400, 'email ou externalId obligatoire', 'invalid');
  const repo = db();
  await ensureTenant(tenantId);
  const filter = externalId ? { externalId: String(externalId) } : { email: String(email).trim().toLowerCase() };
  let [user] = await repo.list('users', tenantId, filter);
  if (!user && email) [user] = await repo.list('users', tenantId, { email: String(email).trim().toLowerCase() });
  const roles = await repo.list('roles', tenantId);
  const validRole = roleId && roles.some((r) => r.id === roleId) ? roleId : null;
  const firstUser = !(await repo.count('users', tenantId));
  user = {
    id: user?.id || crypto.randomUUID(), active: true, productTypeIds: [], ...(user || {}),
    ...(name ? { name } : {}), ...(email ? { email: String(email).trim().toLowerCase() } : {}), ...(phone ? { phone } : {}), ...(role ? { role } : {}),
    ...(externalId ? { externalId: String(externalId) } : {}),
    roleId: validRole || user?.roleId || (firstUser ? ADMIN_ROLE_ID : 'sales'),
    ...(Array.isArray(productTypeIds) ? { productTypeIds } : {}),
  };
  if (!user.name) user.name = user.email || 'Utilisateur';
  if (user.active === false) throw new HttpError(403, 'Compte désactivé', 'disabled');
  await repo.upsert('users', tenantId, { ...user, lastLoginAt: new Date().toISOString() });
  return { token: signToken(user, tenantId), user: publicUser(user), tenantId };
}
