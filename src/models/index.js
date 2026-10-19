/*
 * Modèles MongoDB (Mongoose).
 * - Chaque document a un _id texte (le même identifiant que dans le CRM) et un tenantId (une entreprise cliente).
 * - Les champs listés documentent le modèle ; `strict: false` conserve aussi les champs ajoutés plus tard par le front.
 * - _createdAt / _updatedAt sont gérés par le serveur.
 */
import mongoose from 'mongoose';

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;
const opts = { strict: false, versionKey: false, minimize: false, timestamps: { createdAt: '_createdAt', updatedAt: '_updatedAt' } };
const base = { _id: { type: String, required: true }, tenantId: { type: String, required: true, index: true } };

function define(name, collection, fields, indexes = []) {
  const schema = new Schema({ ...base, ...fields }, { ...opts, collection });
  indexes.forEach((ix) => schema.index({ tenantId: 1, ...ix }));
  return mongoose.models[name] || mongoose.model(name, schema);
}

const Installment = new Schema({
  id: String, method: String, amount: Number, due: Date, ref: String, bank: String,
  status: { type: String, enum: ['pending', 'paid'], default: 'pending' }, paidAt: Date,
}, { _id: false, strict: false });

export const User = define('User', 'users', {
  name: { type: String, required: true }, email: { type: String, lowercase: true, trim: true }, phone: String,
  role: String, roleId: { type: String, required: true }, active: { type: Boolean, default: true },
  productTypeIds: { type: [String], default: [] }, activeTypeId: String,
  passwordHash: String, externalId: String, lastLoginAt: Date,
}, [{ email: 1 }, { externalId: 1 }]);

export const Role = define('Role', 'roles', {
  name: { type: String, required: true }, description: String, locked: Boolean, permissions: { type: Mixed, default: {} },
});

export const Contact = define('Contact', 'contacts', {
  org: { type: String, required: true }, name: String, role: String, phone: String, email: String, city: String,
  type: String, source: String, stage: { type: String, required: true }, maxStageId: String,
  ownerId: { type: String, index: true }, tags: [String], value: Number, probability: Number, lostReason: String,
  noAnswerCount: Number, qualification: Mixed, courseId: String, productTypeId: String,
  payment: { status: String, paid: Number }, schedule: [Installment], people: [Mixed], files: [Mixed],
  createdAt: Date, updatedAt: Date, lastContactAt: Date, wonAt: Date, lostAt: Date,
}, [{ ownerId: 1 }, { stage: 1 }, { productTypeId: 1 }, { createdAt: -1 }, { phone: 1 }, { email: 1 }]);

export const Activity = define('Activity', 'activities', {
  contactId: String, type: String, outcome: String, text: String, userId: String, at: Date,
}, [{ contactId: 1 }, { userId: 1, at: -1 }]);

export const Appointment = define('Appointment', 'appointments', {
  contactId: String, title: String, mode: String, start: Date, duration: Number, location: String, link: String,
  ownerId: String, status: String, evaluation: String, report: String,
}, [{ ownerId: 1, start: 1 }, { contactId: 1 }]);

export const Task = define('Task', 'tasks', {
  title: String, type: String, due: Date, priority: String, contactId: String, ownerId: String, done: Boolean, createdAt: Date,
}, [{ ownerId: 1, due: 1 }, { contactId: 1 }]);

export const Product = define('Product', 'products', {
  name: { type: String, required: true }, typeId: String, category: String, duration: String, description: String,
  price: Number, active: Boolean, sessions: [Mixed], _order: Number,
}, [{ typeId: 1 }]);

export const ProductType = define('ProductType', 'product_types', { one: String, many: String, _order: Number });
export const Guide = define('Guide', 'guides', { name: String, productIds: [String], questions: [String], _order: Number });
export const Stage = define('Stage', 'stages', { label: String, color: String, _order: Number });
export const Clause = define('Clause', 'clauses', { title: String, text: String, active: Boolean, typeIds: [String], _order: Number });

/** Documents uniques par entreprise : profil (company) et paramètres (settings) */
export const Singleton = define('Singleton', 'singletons', { key: { type: String, required: true }, value: Mixed }, [{ key: 1 }]);

/** Nom de collection côté CRM → modèle */
export const MODELS = {
  users: User, roles: Role, contacts: Contact, activities: Activity, appointments: Appointment, tasks: Task,
  catalog: Product, productTypes: ProductType, guides: Guide, stages: Stage, clauses: Clause,
};

export async function syncIndexes() {
  await Promise.all([...Object.values(MODELS), Singleton].map((m) => m.syncIndexes()));
}
