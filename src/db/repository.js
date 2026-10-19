/*
 * Accès aux données : une interface unique, deux implémentations.
 *  - MongoRepository : production (Mongoose / MongoDB)
 *  - MemoryRepository : essais et tests automatiques, sans base de données
 * Les services n'utilisent que cette interface : changer de base ne touche pas aux règles métier.
 *
 * Filtres acceptés (sous-ensemble de la syntaxe MongoDB) :
 *   { champ: valeur }, { champ: { $in: [...] } }, $nin, $ne, $gte, $lte, $gt, $lt, $exists,
 *   { champ: { $regex: 'texte', $options: 'i' } }, { $or: [ ... ] }
 */
import { MODELS, Singleton } from '../models/index.js';

export const COLLECTIONS = Object.keys(MODELS);
export const ORDERED = ['stages', 'clauses', 'productTypes', 'catalog', 'guides'];

const toDoc = (o) => {
  if (!o) return null;
  const { _id, tenantId, _createdAt, _updatedAt, ...rest } = o;
  return { id: _id, ...rest };
};
const assertColl = (c) => { if (!MODELS[c]) throw Object.assign(new Error(`Collection inconnue : ${c}`), { status: 400 }); };

export class MongoRepository {
  async list(coll, tenantId, filter = {}, { sort, limit, skip, projection } = {}) {
    assertColl(coll);
    let q = MODELS[coll].find({ ...filter, tenantId }, projection);
    q = q.sort(sort || (ORDERED.includes(coll) ? { _order: 1, _id: 1 } : { _id: 1 }));
    if (skip) q = q.skip(skip);
    if (limit) q = q.limit(limit);
    return (await q.lean()).map(toDoc);
  }
  async count(coll, tenantId, filter = {}) { assertColl(coll); return MODELS[coll].countDocuments({ ...filter, tenantId }); }
  async get(coll, tenantId, id) { assertColl(coll); return toDoc(await MODELS[coll].findOne({ _id: id, tenantId }).lean()); }
  async getMany(coll, tenantId, ids) { return this.list(coll, tenantId, { _id: { $in: ids } }); }
  async upsert(coll, tenantId, doc) {
    assertColl(coll);
    const { id, ...rest } = doc;
    const Model = MODELS[coll];
    // validation du schéma avant écriture
    const probe = new Model({ ...rest, _id: id, tenantId });
    const err = probe.validateSync();
    if (err) throw Object.assign(new Error(err.message), { status: 400 });
    await Model.replaceOne({ _id: id, tenantId }, { ...probe.toObject(), _id: id, tenantId }, { upsert: true });
    return this.get(coll, tenantId, id);
  }
  async bulkUpsert(coll, tenantId, docs) {
    assertColl(coll);
    if (!docs.length) return 0;
    const Model = MODELS[coll];
    const ops = docs.map(({ id, ...rest }) => ({ replaceOne: { filter: { _id: id, tenantId }, replacement: { ...new Model({ ...rest, _id: id, tenantId }).toObject(), _id: id, tenantId }, upsert: true } }));
    const r = await Model.bulkWrite(ops, { ordered: false });
    return r.upsertedCount + r.modifiedCount + r.matchedCount;
  }
  async remove(coll, tenantId, id) { assertColl(coll); const r = await MODELS[coll].deleteOne({ _id: id, tenantId }); return r.deletedCount > 0; }
  async removeMany(coll, tenantId, filter = {}) { assertColl(coll); const r = await MODELS[coll].deleteMany({ ...filter, tenantId }); return r.deletedCount; }
  async setOrder(coll, tenantId, ids) {
    assertColl(coll);
    if (!ids.length) return;
    await MODELS[coll].bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, tenantId }, update: { $set: { _order: i } } } })), { ordered: false });
  }
  async getSingleton(key, tenantId) { const d = await Singleton.findOne({ _id: `${tenantId}:${key}` }).lean(); return d ? d.value : null; }
  async setSingleton(key, tenantId, value) {
    await Singleton.replaceOne({ _id: `${tenantId}:${key}` }, { _id: `${tenantId}:${key}`, tenantId, key, value }, { upsert: true });
    return value;
  }
}

/* ---------- Implémentation en mémoire ---------- */
const get = (o, path) => path.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const cmp = (a, b) => { const x = a instanceof Date ? a.getTime() : a; const y = b instanceof Date ? b.getTime() : b; const dx = typeof x === 'string' && /^\d{4}-\d\d-\d\d/.test(x) ? Date.parse(x) : x; const dy = typeof y === 'string' && /^\d{4}-\d\d-\d\d/.test(y) ? Date.parse(y) : y; return dx < dy ? -1 : dx > dy ? 1 : 0; };
function matches(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    if (k === '$or') return cond.some((f) => matches(doc, f));
    if (k === '$and') return cond.every((f) => matches(doc, f));
    const v = k === '_id' ? doc.id : get(doc, k);
    if (cond && typeof cond === 'object' && !Array.isArray(cond) && !(cond instanceof Date) && Object.keys(cond).some((x) => x.startsWith('$'))) {
      return Object.entries(cond).every(([op, arg]) => {
        const arr = Array.isArray(v) ? v : [v];
        switch (op) {
          case '$in': return arr.some((x) => arg.includes(x));
          case '$nin': return !arr.some((x) => arg.includes(x));
          case '$ne': return Array.isArray(v) ? !v.includes(arg) : v !== arg;
          case '$exists': return arg ? v !== undefined && v !== null : v === undefined || v === null;
          case '$gte': return v != null && cmp(v, arg) >= 0;
          case '$gt': return v != null && cmp(v, arg) > 0;
          case '$lte': return v != null && cmp(v, arg) <= 0;
          case '$lt': return v != null && cmp(v, arg) < 0;
          case '$regex': return new RegExp(arg, cond.$options || '').test(String(v ?? ''));
          case '$options': return true;
          default: throw new Error(`Opérateur non géré : ${op}`);
        }
      });
    }
    if (cond === null) return v === null || v === undefined;
    return Array.isArray(v) ? v.includes(cond) : v === cond;
  });
}
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

export class MemoryRepository {
  constructor() { this.data = new Map(); this.singletons = new Map(); }
  _c(coll, tenantId) { assertColl(coll); const k = `${tenantId}/${coll}`; if (!this.data.has(k)) this.data.set(k, new Map()); return this.data.get(k); }
  async list(coll, tenantId, filter = {}, { sort, limit, skip } = {}) {
    let out = [...this._c(coll, tenantId).values()].filter((d) => matches(d, filter));
    const s = sort || (ORDERED.includes(coll) ? { _order: 1 } : null);
    if (s) {
      const [[k, dir]] = Object.entries(s);
      out.sort((a, b) => dir * cmp(get(a, k === '_id' ? 'id' : k) ?? Infinity, get(b, k === '_id' ? 'id' : k) ?? Infinity));
    }
    if (skip) out = out.slice(skip);
    if (limit) out = out.slice(0, limit);
    return clone(out);
  }
  async count(coll, tenantId, filter = {}) { return (await this.list(coll, tenantId, filter)).length; }
  async get(coll, tenantId, id) { return clone(this._c(coll, tenantId).get(id) || null); }
  async getMany(coll, tenantId, ids) { return this.list(coll, tenantId, { _id: { $in: ids } }); }
  async upsert(coll, tenantId, doc) {
    const Model = MODELS[coll];
    const { id, ...rest } = doc;
    const err = new Model({ ...rest, _id: id, tenantId }).validateSync();
    if (err) throw Object.assign(new Error(err.message), { status: 400 });
    this._c(coll, tenantId).set(doc.id, clone(doc));
    return clone(doc);
  }
  async bulkUpsert(coll, tenantId, docs) { docs.forEach((d) => this._c(coll, tenantId).set(d.id, clone(d))); return docs.length; }
  async remove(coll, tenantId, id) { return this._c(coll, tenantId).delete(id); }
  async removeMany(coll, tenantId, filter = {}) {
    const c = this._c(coll, tenantId); let n = 0;
    [...c.values()].forEach((d) => { if (matches(d, filter)) { c.delete(d.id); n++; } });
    return n;
  }
  async setOrder(coll, tenantId, ids) { const c = this._c(coll, tenantId); ids.forEach((id, i) => { const d = c.get(id); if (d) d._order = i; }); }
  async getSingleton(key, tenantId) { return clone(this.singletons.get(`${tenantId}:${key}`) ?? null); }
  async setSingleton(key, tenantId, value) { this.singletons.set(`${tenantId}:${key}`, clone(value)); return value; }
}

let repo = null;
export const setRepository = (r) => { repo = r; };
export const db = () => { if (!repo) throw new Error('Base de données non initialisée'); return repo; };
