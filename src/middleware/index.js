import { db } from '../db/repository.js';
import { verifyToken } from '../services/auth.js';
import { buildContext, HttpError } from '../services/context.js';

/** Vérifie le jeton (Authorization: Bearer …) et prépare req.ctx (utilisateur, droits, périmètre) */
export async function auth(req, _res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : null;
    if (!token) throw new HttpError(401, 'Connexion requise', 'unauthorized');
    const { sub, tid } = verifyToken(token);
    const user = await db().get('users', tid, sub);
    if (!user) throw new HttpError(401, 'Compte introuvable', 'unauthorized');
    if (user.active === false) throw new HttpError(403, 'Compte désactivé, contactez un Super admin', 'disabled');
    req.ctx = await buildContext(tid, user);
    next();
  } catch (e) { next(e); }
}

/** Exige un droit : router.get('/x', requirePerm('nav.reports'), …) */
export const requirePerm = (...keys) => (req, _res, next) => (keys.every((k) => req.ctx.can(k)) ? next() : next(new HttpError(403, 'Action non autorisée pour votre rôle', 'forbidden')));
export const requireAdmin = (req, _res, next) => (req.ctx.isAdmin() ? next() : next(new HttpError(403, 'Réservé au Super admin', 'forbidden')));

/** Enveloppe async : les erreurs vont au gestionnaire d'erreurs */
export const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function notFound(req, _res, next) { next(new HttpError(404, `Route inconnue : ${req.method} ${req.originalUrl}`, 'not_found')); }

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, _next) {
  const status = err.status || (err.type === 'entity.too.large' ? 413 : err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500 && status !== 501) console.error('[erreur]', err);
  res.status(status).json({ error: status >= 500 && process.env.NODE_ENV === 'production' ? 'Erreur interne' : err.message, code: err.code || (status >= 500 ? 'server_error' : 'error') });
}
