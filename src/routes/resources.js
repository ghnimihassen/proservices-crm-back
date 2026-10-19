/*
 * API REST par ressource (pour vos autres applications, une appli mobile, des intégrations…).
 *   GET    /api/<ressource>?champ=valeur&q=texte&page=1&limit=50&sort=-createdAt
 *   GET    /api/<ressource>/:id
 *   POST   /api/<ressource>            (création ; id généré si absent)
 *   PUT    /api/<ressource>/:id        (remplacement complet)
 *   PATCH  /api/<ressource>/:id        (modification partielle)
 *   DELETE /api/<ressource>/:id
 *   PUT    /api/<ressource>/order      { ids: [...] }  (ressources ordonnées)
 * Les droits et le périmètre sont ceux de l'utilisateur du jeton (mêmes règles que le CRM).
 */
import crypto from 'node:crypto';
import { Router } from 'express';
import { db, ORDERED } from '../db/repository.js';
import { h } from '../middleware/index.js';
import { applyOrThrow } from '../services/ops.js';
import { contactFilter, canSeeContact, linkedFilter, productFilter, guideVisible } from '../services/scope.js';
import { HttpError, publicUser } from '../services/context.js';

const uid = () => crypto.randomUUID();
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const RESOURCES = {
  contacts: { coll: 'contacts', filters: ['stage', 'ownerId', 'productTypeId', 'courseId', 'source', 'type', 'city'], search: ['org', 'name', 'email', 'phone', 'city'], sort: { createdAt: -1 } },
  activities: { coll: 'activities', filters: ['contactId', 'type', 'userId', 'outcome'], search: ['text'], sort: { at: -1 }, linked: 'userId' },
  appointments: { coll: 'appointments', filters: ['contactId', 'ownerId', 'status', 'mode'], search: ['title', 'location'], sort: { start: 1 }, linked: 'ownerId' },
  tasks: { coll: 'tasks', filters: ['contactId', 'ownerId', 'type', 'priority', 'done'], search: ['title'], sort: { due: 1 }, linked: 'ownerId' },
  products: { coll: 'catalog', filters: ['typeId', 'category', 'active'], search: ['name', 'category', 'description'] },
  'product-types': { coll: 'productTypes', filters: [], search: ['one', 'many'] },
  guides: { coll: 'guides', filters: [], search: ['name'] },
  stages: { coll: 'stages', filters: [], search: ['label'] },
  clauses: { coll: 'clauses', filters: ['active'], search: ['title', 'text'] },
  users: { coll: 'users', filters: ['roleId', 'active'], search: ['name', 'email'], out: publicUser },
  roles: { coll: 'roles', filters: [], search: ['name'] },
};

const cast = (v) => (v === 'true' ? true : v === 'false' ? false : v);

/** Filtre de lecture selon le périmètre de l'utilisateur */
async function scopeFilter(ctx, R) {
  if (R.coll === 'contacts') return contactFilter(ctx);
  if (R.linked) {
    const ids = (await db().list('contacts', ctx.tenantId, contactFilter(ctx), { projection: { _id: 1 } })).map((c) => c.id);
    return linkedFilter(ctx, ids, R.linked);
  }
  if (R.coll === 'catalog') return productFilter(ctx);
  if (R.coll === 'productTypes') { const t = ctx.allowedTypes(); return t ? { _id: { $in: t } } : {}; }
  return {};
}

async function visible(ctx, R, doc) {
  if (!doc) return false;
  if (R.coll === 'contacts') return canSeeContact(ctx, doc);
  if (R.linked) {
    if (doc.contactId) return canSeeContact(ctx, await db().get('contacts', ctx.tenantId, doc.contactId));
    return ctx.can('data.all') || doc[R.linked] === ctx.user.id;
  }
  if (R.coll === 'catalog') { const t = ctx.allowedTypes(); return !t || t.includes(doc.typeId); }
  if (R.coll === 'productTypes') { const t = ctx.allowedTypes(); return !t || t.includes(doc.id); }
  if (R.coll === 'guides') {
    const prods = new Set((await db().list('catalog', ctx.tenantId, productFilter(ctx), { projection: { _id: 1 } })).map((p) => p.id));
    return guideVisible(doc, prods);
  }
  return true;
}

export function resourceRouter() {
  const r = Router();
  for (const [path, R] of Object.entries(RESOURCES)) {
    const out = R.out || ((d) => d);
    const load = async (req) => {
      const d = await db().get(R.coll, req.ctx.tenantId, req.params.id);
      if (!d || !(await visible(req.ctx, R, d))) throw new HttpError(404, 'Introuvable', 'not_found');
      return d;
    };
    const save = async (req, doc) => {
      await applyOrThrow(req.ctx, [{ coll: R.coll, op: 'upsert', doc }]);
      return out(await db().get(R.coll, req.ctx.tenantId, doc.id));
    };

    r.get(`/${path}`, h(async (req, res) => {
      const { q, page = 1, limit = 100, sort } = req.query;
      const f = { ...(await scopeFilter(req.ctx, R)) };
      for (const k of R.filters) if (req.query[k] !== undefined) f[k] = cast(req.query[k]);
      if (req.query.updatedSince) f._updatedAt = { $gte: new Date(req.query.updatedSince) };
      if (q && R.search.length) {
        const or = R.search.map((k) => ({ [k]: { $regex: esc(q), $options: 'i' } }));
        if (f.$or) { f.$and = [{ $or: f.$or }, { $or: or }]; delete f.$or; } else f.$or = or;
      }
      const lim = Math.min(500, Math.max(1, Number(limit) || 100));
      const skip = (Math.max(1, Number(page) || 1) - 1) * lim;
      const srt = sort ? { [String(sort).replace(/^-/, '')]: String(sort).startsWith('-') ? -1 : 1 } : R.sort;
      let [items, total] = await Promise.all([db().list(R.coll, req.ctx.tenantId, f, { sort: srt, limit: lim, skip }), db().count(R.coll, req.ctx.tenantId, f)]);
      if (R.coll === 'guides') { const ok = await Promise.all(items.map((g) => visible(req.ctx, R, g))); items = items.filter((_, i) => ok[i]); }
      res.json({ items: items.map(out), total, page: Number(page) || 1, limit: lim });
    }));

    if (ORDERED.includes(R.coll)) {
      r.put(`/${path}/order`, h(async (req, res) => {
        await applyOrThrow(req.ctx, [{ coll: R.coll, op: 'order', ids: req.body?.ids || [] }]);
        res.json({ ok: true });
      }));
    }

    r.get(`/${path}/:id`, h(async (req, res) => res.json(out(await load(req)))));

    r.post(`/${path}`, h(async (req, res) => {
      const doc = { ...req.body, id: req.body?.id || uid() };
      if (await db().get(R.coll, req.ctx.tenantId, doc.id)) throw new HttpError(409, 'Cet identifiant existe déjà', 'conflict');
      if (R.coll === 'contacts') Object.assign(doc, { createdAt: doc.createdAt || new Date().toISOString(), stage: doc.stage || 'new', tags: doc.tags || [], schedule: doc.schedule || [] });
      if (R.coll === 'activities') doc.at = doc.at || new Date().toISOString();
      res.status(201).json(await save(req, doc));
    }));

    r.put(`/${path}/:id`, h(async (req, res) => {
      const old = await db().get(R.coll, req.ctx.tenantId, req.params.id);
      if (old && !(await visible(req.ctx, R, old))) throw new HttpError(404, 'Introuvable', 'not_found');
      res.json(await save(req, { ...req.body, id: req.params.id, ...(R.coll === 'users' && old ? {} : {}) }));
    }));

    r.patch(`/${path}/:id`, h(async (req, res) => {
      const old = await load(req);
      res.json(await save(req, { ...(R.coll === 'users' ? publicUser(old) : old), ...req.body, id: old.id, updatedAt: new Date().toISOString() }));
    }));

    r.delete(`/${path}/:id`, h(async (req, res) => {
      await load(req);
      await applyOrThrow(req.ctx, [{ coll: R.coll, op: 'delete', id: req.params.id }]);
      res.status(204).end();
    }));
  }
  return r;
}
