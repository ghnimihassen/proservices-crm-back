/*
 * Périmètre de lecture côté serveur — les mêmes règles que l'interface, mais appliquées à la base :
 *  - sans « data.all » : uniquement les prospects dont l'utilisateur est responsable ;
 *  - avec des activités limitées (users[].productTypeIds) : uniquement ces types de produits.
 * Un utilisateur ne reçoit donc jamais les données qu'il n'a pas le droit de voir, même en appelant l'API directement.
 */
import { db } from '../db/repository.js';

export function contactFilter(ctx) {
  const f = {};
  if (!ctx.can('data.all')) f.ownerId = ctx.user.id;
  const types = ctx.allowedTypes();
  if (types) f.productTypeId = { $in: types };
  return f;
}

export function canSeeContact(ctx, c) {
  if (!c) return false;
  if (!ctx.can('data.all') && c.ownerId !== ctx.user.id) return false;
  const types = ctx.allowedTypes();
  return !types || types.includes(c.productTypeId);
}

const unrestricted = (ctx) => ctx.can('data.all') && !ctx.allowedTypes();

/** Filtre pour activités / RDV / tâches liés aux prospects visibles */
export function linkedFilter(ctx, contactIds, ownerField) {
  if (unrestricted(ctx)) return {};
  const own = { contactId: null };
  if (!ctx.can('data.all')) own[ownerField] = ctx.user.id;
  return { $or: [{ contactId: { $in: contactIds } }, own] };
}

export function productFilter(ctx) {
  const types = ctx.allowedTypes();
  return types ? { typeId: { $in: types } } : {};
}

export const guideVisible = (g, productIds) => !(g.productIds || []).length || g.productIds.some((id) => productIds.has(id));

/** Toutes les données visibles par l'utilisateur, au format de l'état du CRM */
export async function loadScopedState(ctx) {
  const repo = db(); const t = ctx.tenantId;
  const contacts = await repo.list('contacts', t, contactFilter(ctx), { sort: { createdAt: -1 } });
  const ids = contacts.map((c) => c.id);
  const types = ctx.allowedTypes();
  const [activities, appointments, tasks, catalog, productTypes, guides, users, roles, stages, clauses, company, settings] = await Promise.all([
    repo.list('activities', t, linkedFilter(ctx, ids, 'userId'), { sort: { at: 1 } }),
    repo.list('appointments', t, linkedFilter(ctx, ids, 'ownerId'), { sort: { start: 1 } }),
    repo.list('tasks', t, linkedFilter(ctx, ids, 'ownerId'), { sort: { due: 1 } }),
    repo.list('catalog', t, productFilter(ctx)),
    repo.list('productTypes', t, types ? { _id: { $in: types } } : {}),
    repo.list('guides', t),
    repo.list('users', t),
    repo.list('roles', t),
    repo.list('stages', t),
    repo.list('clauses', t),
    repo.getSingleton('company', t),
    repo.getSingleton('settings', t),
  ]);
  const prodIds = new Set(catalog.map((p) => p.id));
  return {
    contacts, activities, appointments, tasks, catalog, productTypes,
    guides: guides.filter((g) => guideVisible(g, prodIds)),
    users, roles, stages, clauses, company: company || {}, settings: settings || {},
  };
}
