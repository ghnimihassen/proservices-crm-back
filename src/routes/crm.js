import crypto from 'node:crypto';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { db } from '../db/repository.js';
import { auth, h, requireAdmin, requirePerm } from '../middleware/index.js';
import { login, createFirstAdmin, ssoLogin } from '../services/auth.js';
import { applyOps, applyOrThrow } from '../services/ops.js';
import { loadScopedState, canSeeContact } from '../services/scope.js';
import { ensureTenant, publicUser, HttpError } from '../services/context.js';
import { importState } from '../services/importer.js';
import { askAI } from '../services/ai.js';
import { summary } from '../services/stats.js';
import { resourceRouter } from './resources.js';
import bcrypt from 'bcryptjs';

const uid = () => crypto.randomUUID();

export function apiRouter() {
  const r = Router();

  /* ---------- Santé ---------- */
  r.get('/health', (_req, res) => res.json({ ok: true, db: config.dbDriver, time: new Date().toISOString() }));

  /* ---------- Authentification ---------- */
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.loginRateLimit, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Trop de tentatives, réessayez dans quelques minutes', code: 'rate_limited' } });
  r.post('/auth/login', limiter, h(async (req, res) => res.json(await login({ email: req.body?.email, password: req.body?.password, tenantId: req.body?.tenantId || config.defaultTenant }))));
  r.get('/auth/setup', h(async (req, res) => res.json({ needed: !(await db().count('users', req.query.tenantId || config.defaultTenant)) })));
  r.post('/auth/setup', limiter, h(async (req, res) => res.status(201).json(await createFirstAdmin({ ...req.body, tenantId: req.body?.tenantId || config.defaultTenant }))));
  r.post('/auth/sso', limiter, h(async (req, res) => res.json(await ssoLogin({ ...req.body, secret: req.headers['x-sso-secret'], tenantId: req.body?.tenantId || config.defaultTenant }))));

  r.use(auth);

  r.get('/auth/me', h(async (req, res) => res.json({ user: publicUser(req.ctx.user), tenantId: req.ctx.tenantId })));
  r.post('/auth/password', h(async (req, res) => {
    const { current, password } = req.body || {};
    const u = req.ctx.user;
    if (u.passwordHash && !(await bcrypt.compare(String(current || ''), u.passwordHash))) throw new HttpError(400, 'Mot de passe actuel incorrect', 'invalid');
    if (String(password || '').length < 8) throw new HttpError(400, 'Le mot de passe doit contenir au moins 8 caractères', 'invalid');
    await db().upsert('users', req.ctx.tenantId, { ...u, passwordHash: await bcrypt.hash(String(password), 10) });
    res.json({ ok: true });
  }));

  /* ---------- CRM : chargement et synchronisation ---------- */
  r.get('/bootstrap', h(async (req, res) => {
    await ensureTenant(req.ctx.tenantId);
    const state = await loadScopedState(req.ctx);
    res.json({ me: publicUser(req.ctx.user), tenantId: req.ctx.tenantId, state: { ...state, users: state.users.map(publicUser), settings: { ...state.settings, currentUserId: req.ctx.user.id } } });
  }));
  r.post('/sync', h(async (req, res) => res.json(await applyOps(req.ctx, req.body?.ops))));

  /* ---------- Administration ---------- */
  r.post('/admin/import', requireAdmin, h(async (req, res) => res.json({ ok: true, imported: await importState(req.ctx, req.body?.state, { mode: req.body?.mode === 'merge' ? 'merge' : 'replace' }) })));
  r.get('/admin/export', requireAdmin, h(async (req, res) => {
    const state = await loadScopedState(req.ctx);
    res.setHeader('Content-Disposition', `attachment; filename="crm-${req.ctx.tenantId}-${new Date().toISOString().slice(0, 10)}.json"`);
    res.json({ version: 2, exportedAt: new Date().toISOString(), ...state, users: state.users.map(publicUser) });
  }));

  /* ---------- Membres ---------- */
  r.put('/users/:id/password', requirePerm('team.manage'), h(async (req, res) => {
    const u = await db().get('users', req.ctx.tenantId, req.params.id);
    if (!u) throw new HttpError(404, 'Membre introuvable', 'not_found');
    if (u.roleId === 'admin' && !req.ctx.isAdmin()) throw new HttpError(403, 'Seul un Super admin peut changer ce mot de passe', 'forbidden');
    await applyOrThrow(req.ctx, [{ coll: 'users', op: 'upsert', doc: { ...publicUser(u), password: req.body?.password } }]);
    res.json({ ok: true });
  }));
  r.put('/me/active-type', h(async (req, res) => {
    await applyOrThrow(req.ctx, [{ coll: 'users', op: 'upsert', doc: { ...publicUser(req.ctx.user), activeTypeId: req.body?.typeId || '' } }]);
    res.json({ ok: true });
  }));

  /* ---------- Profil de l'entreprise et paramètres ---------- */
  for (const key of ['company', 'settings']) {
    r.get(`/${key}`, h(async (req, res) => res.json((await db().getSingleton(key, req.ctx.tenantId)) || {})));
    r.put(`/${key}`, h(async (req, res) => { await applyOrThrow(req.ctx, [{ coll: key, op: 'set', doc: req.body || {} }]); res.json(await db().getSingleton(key, req.ctx.tenantId)); }));
  }

  /* ---------- Prospects : opérations métier ---------- */
  const contact = async (req) => {
    const c = await db().get('contacts', req.ctx.tenantId, req.params.id);
    if (!canSeeContact(req.ctx, c)) throw new HttpError(404, 'Prospect introuvable', 'not_found');
    return c;
  };
  const saveContact = async (req, c) => { await applyOrThrow(req.ctx, [{ coll: 'contacts', op: 'upsert', doc: { ...c, updatedAt: new Date().toISOString() } }]); return db().get('contacts', req.ctx.tenantId, c.id); };

  r.post('/contacts/import', h(async (req, res) => {
    const list = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    const now = new Date().toISOString();
    const ops = list.slice(0, 5000).map((c) => ({ coll: 'contacts', op: 'upsert', doc: { stage: 'new', source: 'Import', tags: [], schedule: [], createdAt: now, ...c, id: c.id || uid() } }));
    res.json(await applyOps(req.ctx, ops));
  }));
  r.patch('/contacts/bulk', h(async (req, res) => {
    const { ids = [], patch = {} } = req.body || {};
    const docs = await db().getMany('contacts', req.ctx.tenantId, ids.slice(0, 2000));
    res.json(await applyOps(req.ctx, docs.filter((c) => canSeeContact(req.ctx, c)).map((c) => ({ coll: 'contacts', op: 'upsert', doc: { ...c, ...patch, id: c.id, updatedAt: new Date().toISOString() } }))));
  }));
  r.get('/contacts/:id/timeline', h(async (req, res) => {
    const c = await contact(req); const t = req.ctx.tenantId;
    const [activities, appointments, tasks] = await Promise.all([
      db().list('activities', t, { contactId: c.id }, { sort: { at: -1 } }), db().list('appointments', t, { contactId: c.id }, { sort: { start: -1 } }), db().list('tasks', t, { contactId: c.id }, { sort: { due: 1 } }),
    ]);
    res.json({ contact: c, activities, appointments, tasks });
  }));
  // Échéancier
  r.post('/contacts/:id/installments', h(async (req, res) => {
    const c = await contact(req);
    const { method = 'cash', amount, due, ref = '', bank = '' } = req.body || {};
    if (!(Number(amount) > 0) || !due) throw new HttpError(400, 'amount (> 0) et due (date) obligatoires', 'invalid');
    res.status(201).json(await saveContact(req, { ...c, schedule: [...(c.schedule || []), { id: uid(), method, amount: Number(amount), due, ref, bank, status: 'pending', paidAt: null }] }));
  }));
  r.patch('/contacts/:id/installments/:iid', h(async (req, res) => {
    const c = await contact(req);
    if (!(c.schedule || []).some((i) => i.id === req.params.iid)) throw new HttpError(404, 'Échéance introuvable', 'not_found');
    const { status, paidAt, ...edit } = req.body || {};
    res.json(await saveContact(req, { ...c, schedule: c.schedule.map((i) => (i.id === req.params.iid ? { ...i, ...edit, amount: edit.amount !== undefined ? Number(edit.amount) : i.amount } : i)) }));
  }));
  r.delete('/contacts/:id/installments/:iid', h(async (req, res) => {
    const c = await contact(req);
    res.json(await saveContact(req, { ...c, schedule: (c.schedule || []).filter((i) => i.id !== req.params.iid) }));
  }));
  r.post('/contacts/:id/installments/:iid/pay', h(async (req, res) => {
    const c = await contact(req);
    const paid = req.body?.paid !== false;
    res.json(await saveContact(req, { ...c, schedule: (c.schedule || []).map((i) => (i.id === req.params.iid ? { ...i, status: paid ? 'paid' : 'pending', paidAt: paid ? (req.body?.paidAt || new Date().toISOString()) : null } : i)) }));
  }));
  r.post('/contacts/:id/payments', h(async (req, res) => {
    const c = await contact(req);
    const { amount, method = 'cash', ref = '' } = req.body || {};
    if (!(Number(amount) > 0)) throw new HttpError(400, 'amount (> 0) obligatoire', 'invalid');
    const now = new Date().toISOString();
    res.status(201).json(await saveContact(req, { ...c, schedule: [...(c.schedule || []), { id: uid(), method, amount: Number(amount), due: now, ref, bank: '', status: 'paid', paidAt: now }] }));
  }));

  /* ---------- Statistiques (mêmes droits que le CRM : montants seulement avec finance.view) ---------- */
  r.get('/stats/summary', requirePerm('nav.reports'), h(async (req, res) => res.json(await summary(req.ctx, { months: Number(req.query.months) || 12 }))));

  /* ---------- IA ---------- */
  r.post('/ai', h(async (req, res) => res.json({ answer: await askAI(req.ctx, req.body || {}) })));

  r.use(resourceRouter());
  return r;
}
