/*
 * Écritures : toutes les modifications passent par applyOps(), que ce soit
 *  - la synchronisation du CRM (POST /api/sync : le front envoie ce qui a changé),
 *  - ou les routes REST (/api/contacts, /api/tasks…), qui fabriquent les mêmes opérations.
 * Pour chaque opération : contrôle des droits, du périmètre, des règles métier, puis normalisation.
 *
 * Opération : { coll, op: 'upsert' | 'delete' | 'order' | 'set', doc?, id?, ids? }
 */
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db, COLLECTIONS, ORDERED } from '../db/repository.js';
import { canSeeContact } from './scope.js';
import { HttpError, ADMIN_ROLE_ID } from './context.js';
import { CLIENT_ONLY_SETTINGS } from './defaults.js';

const SINGLETONS = ['company', 'settings'];
const OpSchema = z.object({
  coll: z.enum([...COLLECTIONS, ...SINGLETONS]),
  op: z.enum(['upsert', 'delete', 'order', 'set']),
  doc: z.record(z.string(), z.any()).optional(),
  id: z.string().min(1).max(200).optional(),
  ids: z.array(z.string().max(200)).max(5000).optional(),
}).superRefine((o, c) => {
  if (o.op === 'upsert' && !(o.doc && typeof o.doc.id === 'string' && o.doc.id)) c.addIssue({ code: 'custom', message: 'doc.id obligatoire' });
  if (o.op === 'delete' && !o.id) c.addIssue({ code: 'custom', message: 'id obligatoire' });
  if (o.op === 'order' && !(o.ids && ORDERED.includes(o.coll))) c.addIssue({ code: 'custom', message: 'ids obligatoire (collection ordonnée)' });
  if (o.op === 'set' && !(SINGLETONS.includes(o.coll) && o.doc)) c.addIssue({ code: 'custom', message: 'set : company ou settings' });
});
export const OpsSchema = z.array(OpSchema).max(5000);

const num = (v) => Number(v) || 0;
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const changedKeys = (a = {}, b = {}) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => !['updatedAt', '_order', 'payment'].includes(k) && !same(a[k], b[k]));
const reject = (msg) => { throw new HttpError(403, msg, 'forbidden'); };
const invalid = (msg) => { throw new HttpError(400, msg, 'invalid'); };

/* ---------- Règles métier partagées avec le front ---------- */
export function withPayment(c) {
  const paid = (c.schedule || []).filter((i) => i.status === 'paid').reduce((s, i) => s + num(i.amount), 0);
  const total = num(c.value);
  return { ...c, payment: { status: paid <= 0 ? 'none' : paid >= total && total > 0 ? 'paid' : 'deposit', paid } };
}

/** Quelles modifications de l'échéancier : planification (montants, dates) ou encaissement (statut) ? */
function scheduleChanges(before = [], after = []) {
  const b = new Map(before.map((i) => [i.id, i])); const a = new Map(after.map((i) => [i.id, i]));
  let plan = false; let collect = false;
  for (const [id, i] of a) {
    const o = b.get(id);
    if (!o) { if (i.status === 'paid') collect = true; else plan = true; continue; }
    if (['amount', 'due', 'method', 'ref', 'bank'].some((k) => !same(o[k], i[k]))) plan = true;
    if (o.status !== i.status || !same(o.paidAt, i.paidAt)) collect = true;
  }
  for (const id of b.keys()) if (!a.has(id)) { if (b.get(id).status === 'paid') collect = true; else plan = true; }
  return { plan, collect };
}

/* ---------- Évaluation d'un lot d'opérations ---------- */
class Batch {
  constructor(ctx) { this.ctx = ctx; this.cache = new Map(); this.deleted = new Map(); this.repo = db(); }
  key(coll, id) { return `${coll}:${id}`; }
  async get(coll, id) {
    const k = this.key(coll, id);
    if (this.cache.has(k)) return this.cache.get(k);
    if (this.deleted.has(k)) return null;
    const d = await this.repo.get(coll, this.ctx.tenantId, id);
    this.cache.set(k, d);
    return d;
  }
  /** Prospect pour un contrôle de visibilité (y compris supprimé dans le même lot : suppressions en cascade) */
  async contact(id) { return (await this.get('contacts', id)) || this.deleted.get(this.key('contacts', id)) || null; }
  put(coll, doc) { this.cache.set(this.key(coll, doc.id), doc); }
  drop(coll, id, doc) { this.cache.delete(this.key(coll, id)); this.deleted.set(this.key(coll, id), doc); }
}

async function productType(batch, productId) {
  if (!productId) return null;
  const p = await batch.get('catalog', productId);
  return p?.typeId || null;
}

const RULES = {
  async contacts(b, op, doc, old) {
    const { ctx } = b;
    if (op === 'delete') {
      if (!ctx.can('contacts.delete')) reject('Suppression de prospects non autorisée');
      if (!canSeeContact(ctx, old)) reject('Prospect hors de votre périmètre');
      return;
    }
    let d = { ...doc };
    if (!d.org || !String(d.org).trim()) invalid('Le nom du prospect est obligatoire');
    // l'activité suit le produit choisi
    const pt = await productType(b, d.courseId);
    if (pt) d.productTypeId = pt;
    const types = ctx.allowedTypes();
    if (!old) {
      if (!ctx.can('contacts.create') && !ctx.can('contacts.import')) reject('Ajout de prospects non autorisé');
      if (!d.ownerId || (!ctx.can('contacts.assign') && d.ownerId !== ctx.user.id)) d.ownerId = ctx.user.id;
      if (types && !types.includes(d.productTypeId)) {
        if (types.length === 1 && !d.productTypeId) d.productTypeId = types[0]; else reject('Activité (type de produit) non autorisée');
      }
      if ((d.schedule || []).length) { const sc = scheduleChanges([], d.schedule); if (sc.plan && !ctx.can('payments.plan')) reject('Planification des paiements non autorisée'); if (sc.collect && !ctx.can('payments.collect')) reject('Encaissement non autorisé'); }
    } else {
      if (!canSeeContact(ctx, old)) reject('Prospect hors de votre périmètre');
      const keys = changedKeys(old, d);
      const other = keys.filter((k) => !['schedule', 'lastContactAt', 'noAnswerCount'].includes(k));
      if (other.length && !ctx.can('contacts.edit')) reject('Modification des prospects non autorisée');
      if (keys.includes('ownerId') && !ctx.can('contacts.assign')) reject('Réassignation non autorisée');
      if (keys.includes('schedule')) {
        const sc = scheduleChanges(old.schedule, d.schedule);
        if (sc.plan && !ctx.can('payments.plan')) reject('Planification des paiements non autorisée');
        if (sc.collect && !ctx.can('payments.collect')) reject('Encaissement non autorisé');
      }
      if (types && !types.includes(d.productTypeId)) reject('Activité (type de produit) non autorisée');
    }
    const planned = (d.schedule || []).reduce((s, i) => s + num(i.amount), 0);
    if (planned > num(d.value) + 0.01 && (d.schedule || []).length) invalid(`Le total des échéances (${planned}) dépasse le montant (${num(d.value)})`);
    return withPayment(d);
  },

  async activities(b, op, doc, old) {
    const { ctx } = b; const d = doc || old;
    const own = (old || doc).userId === ctx.user.id;
    if (d.contactId) {
      const c = await b.contact(d.contactId);
      if (!canSeeContact(ctx, c)) reject('Prospect hors de votre périmètre');
    }
    if (op === 'delete') { if (!own && !ctx.can('data.all') && !ctx.can('contacts.delete')) reject('Suppression non autorisée'); return; }
    if (old && !own && !ctx.can('data.all')) reject('Vous ne pouvez modifier que vos propres activités');
    return { ...doc, userId: old ? old.userId : (doc.userId && ctx.can('data.all') ? doc.userId : ctx.user.id) };
  },

  async appointments(b, op, doc, old) { return linked(b, op, doc, old); },
  async tasks(b, op, doc, old) { return linked(b, op, doc, old); },

  async catalog(b, op, doc) {
    if (!b.ctx.can('products.manage')) reject('Gestion des produits non autorisée');
    if (op !== 'delete' && !doc.name) invalid('Le nom du produit est obligatoire');
    return doc;
  },
  async productTypes(b, op, doc) { if (!b.ctx.can('products.manage')) reject('Gestion des types de produits non autorisée'); return doc; },
  async guides(b, op, doc) { if (!b.ctx.can('guides.manage')) reject('Gestion des guides non autorisée'); return doc; },
  async clauses(b, op, doc) { if (!b.ctx.can('clauses.manage')) reject('Gestion des conditions générales non autorisée'); return doc; },
  async stages(b, op, doc, old) {
    if (!b.ctx.can('pipeline.configure')) reject('Configuration du pipeline non autorisée');
    if (op === 'delete' && ['won', 'lost'].includes(old?.id)) invalid('Les colonnes « gagné » et « perdu » sont obligatoires');
    return doc;
  },

  async roles(b, op, doc, old) {
    if (!b.ctx.isAdmin()) reject('Seul un Super admin gère les rôles');
    if ((old?.locked || old?.id === ADMIN_ROLE_ID) && op === 'delete') invalid('Le rôle Super admin ne peut pas être supprimé');
    if (old?.locked) return { ...old };
    return { ...doc, locked: false };
  },

  async users(b, op, doc, old) {
    const { ctx } = b;
    const self = (old || doc).id === ctx.user.id;
    const admin = ctx.isAdmin();
    if (op === 'delete') {
      if (!ctx.can('team.manage')) reject('Gestion de l’équipe non autorisée');
      if (self) invalid('Vous ne pouvez pas supprimer votre propre compte');
      if (old?.roleId === ADMIN_ROLE_ID && !admin) reject('Seul un Super admin peut supprimer un Super admin');
      if (old?.roleId === ADMIN_ROLE_ID && (await adminCount(b, old.id)) === 0) invalid('Il doit rester au moins un Super admin');
      return;
    }
    const { password, passwordHash, hasPassword, ...clean } = doc;
    const keys = changedKeys(old ? (({ passwordHash: _p, ...r }) => r)(old) : {}, clean);
    const onlyPrefs = old && self && keys.every((k) => ['activeTypeId'].includes(k)) && !password;
    if (!onlyPrefs) {
      if (!ctx.can('team.manage')) reject('Gestion de l’équipe non autorisée');
      if (!admin && (clean.roleId === ADMIN_ROLE_ID || old?.roleId === ADMIN_ROLE_ID)) reject('Seul un Super admin peut attribuer ou modifier ce rôle');
      if (!clean.name) invalid('Le nom est obligatoire');
      if (!clean.roleId) clean.roleId = 'sales';
      if (old?.roleId === ADMIN_ROLE_ID && (clean.roleId !== ADMIN_ROLE_ID || clean.active === false) && (await adminCount(b, old.id)) === 0) invalid('Il doit rester au moins un Super admin');
      if (clean.email) {
        clean.email = String(clean.email).trim().toLowerCase();
        const dup = (await b.repo.list('users', ctx.tenantId, { email: clean.email })).find((u) => u.id !== clean.id);
        if (dup) invalid('Cet email est déjà utilisé par un autre membre');
      }
    }
    const out = { ...(old || {}), ...clean, productTypeIds: Array.isArray(clean.productTypeIds) ? clean.productTypeIds : (old?.productTypeIds || []) };
    if (onlyPrefs) Object.assign(out, old, { activeTypeId: clean.activeTypeId || '' });
    if (password) {
      if (String(password).length < 8) invalid('Le mot de passe doit contenir au moins 8 caractères');
      out.passwordHash = await bcrypt.hash(String(password), 10);
    } else if (old?.passwordHash) out.passwordHash = old.passwordHash;
    return out;
  },
};

async function adminCount(b, excludeId) {
  const admins = await b.repo.list('users', b.ctx.tenantId, { roleId: ADMIN_ROLE_ID });
  return admins.filter((u) => u.id !== excludeId && u.active !== false).length;
}

async function linked(b, op, doc, old) {
  const { ctx } = b; const d = doc || old;
  const own = (old || doc).ownerId === ctx.user.id;
  if (d.contactId) {
    const c = await b.contact(d.contactId);
    if (!canSeeContact(ctx, c)) reject('Prospect hors de votre périmètre');
  } else if (!own && !ctx.can('data.all')) reject('Élément hors de votre périmètre');
  if (op === 'delete') { if (!own && !ctx.can('data.all') && !ctx.can('contacts.edit')) reject('Suppression non autorisée'); return; }
  if (old && !own && !ctx.can('data.all') && !d.contactId) reject('Élément hors de votre périmètre');
  const out = { ...doc };
  if (!out.ownerId || (!ctx.can('data.all') && !ctx.can('contacts.assign') && out.ownerId !== ctx.user.id && !old)) out.ownerId = ctx.user.id;
  return out;
}

const SINGLETON_RULES = {
  company: (ctx) => ctx.can('company.manage') || reject('Modification du profil de l’entreprise non autorisée'),
  settings: (ctx) => ctx.can('team.manage') || reject('Modification des paramètres non autorisée'),
};

/**
 * Applique un lot d'opérations. Les opérations refusées n'empêchent pas les autres.
 * @returns {{ results: Array<{ ok: boolean, coll, id, error?, code? }>, applied: number }}
 */
export async function applyOps(ctx, rawOps) {
  const parsed = OpsSchema.safeParse(rawOps);
  if (!parsed.success) throw new HttpError(400, `Opérations invalides : ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join(' ; ')}`, 'invalid');
  const b = new Batch(ctx);
  const repo = db(); const t = ctx.tenantId;
  const results = [];
  for (const o of parsed.data) {
    const id = o.op === 'upsert' ? o.doc.id : o.id;
    try {
      if (SINGLETONS.includes(o.coll)) {
        const cur = (await repo.getSingleton(o.coll, t)) || {};
        const next = { ...o.doc };
        if (o.coll === 'settings') CLIENT_ONLY_SETTINGS.forEach((k) => delete next[k]);
        if (same(cur, { ...cur, ...next })) { results.push({ ok: true, coll: o.coll, unchanged: true }); continue; }
        SINGLETON_RULES[o.coll](ctx);
        await repo.setSingleton(o.coll, t, { ...cur, ...next });
        results.push({ ok: true, coll: o.coll });
        continue;
      }
      if (o.op === 'order') {
        const perm = { stages: 'pipeline.configure', clauses: 'clauses.manage', productTypes: 'products.manage', catalog: 'products.manage', guides: 'guides.manage' }[o.coll];
        if (!ctx.can(perm)) reject('Réorganisation non autorisée');
        await repo.setOrder(o.coll, t, o.ids);
        results.push({ ok: true, coll: o.coll, op: 'order' });
        continue;
      }
      const old = await b.get(o.coll, id);
      if (o.op === 'delete') {
        if (!old) { results.push({ ok: true, coll: o.coll, id, missing: true }); continue; }
        await RULES[o.coll](b, 'delete', null, old);
        await repo.remove(o.coll, t, id);
        b.drop(o.coll, id, old);
        results.push({ ok: true, coll: o.coll, id, op: 'delete' });
        continue;
      }
      let doc = await RULES[o.coll](b, 'upsert', o.doc, old);
      if (ORDERED.includes(o.coll)) doc._order = doc._order ?? old?._order ?? (await repo.count(o.coll, t));
      doc.id = id;
      const saved = await repo.upsert(o.coll, t, doc);
      b.put(o.coll, saved);
      results.push({ ok: true, coll: o.coll, id, op: 'upsert' });
    } catch (e) {
      if (!e.status) throw e;
      results.push({ ok: false, coll: o.coll, id, error: e.message, code: e.code });
    }
  }
  return { results, applied: results.filter((r) => r.ok).length, rejected: results.filter((r) => !r.ok).length };
}

/** Applique et lève une erreur si une opération est refusée (routes REST) */
export async function applyOrThrow(ctx, ops) {
  const r = await applyOps(ctx, ops);
  const bad = r.results.find((x) => !x.ok);
  if (bad) throw new HttpError(bad.code === 'invalid' ? 400 : 403, bad.error, bad.code);
  return r;
}
