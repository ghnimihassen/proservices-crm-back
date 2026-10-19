/* Tests de l'API (base en mémoire) : node --test test/ */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';

process.env.NODE_ENV = 'test';
process.env.DB_DRIVER = 'memory';
process.env.SSO_SECRET = 'sso-test-secret';
process.env.LOGIN_RATE_LIMIT = '1000';
process.env.CORS_ORIGINS = 'https://only-this-origin.example';

const { setRepository, MemoryRepository } = await import('../src/db/repository.js');
const { createApp } = await import('../src/app.js');
const { stripMoney } = await import('../src/services/ai.js');
setRepository(new MemoryRepository());
const app = createApp();
const api = () => request(app);
const H = (t) => ({ Authorization: `Bearer ${t}` });
const iso = (d = 0) => new Date(Date.now() + d * 864e5).toISOString();

let admin; let sales; let salesId; let karimId;
const sync = (tok, ops) => api().post('/api/sync').set(H(tok)).send({ ops });

before(async () => {
  const r = await api().post('/api/auth/setup').send({ name: 'Nour', email: 'Nour@Test.tn', password: 'motdepasse1' });
  assert.equal(r.status, 201);
  admin = r.body.token;
  // Données : 2 types, 2 produits, 3 prospects, 1 commerciale limitée aux Formations
  const state = {
    productTypes: [{ id: 't1', one: 'Formation', many: 'Formations' }, { id: 't2', one: 'Erudaxis', many: 'Erudaxis' }],
    catalog: [{ id: 'f1', name: 'Web', typeId: 't1', price: 2400 }, { id: 'e1', name: 'Licence', typeId: 't2', price: 4800 }],
    users: [{ id: 'u3', name: 'Salma', email: 'salma@test.tn', roleId: 'sales', productTypeIds: ['t1'] }, { id: 'u4', name: 'Karim', email: 'karim@test.tn', roleId: 'sales', productTypeIds: ['t2'] }],
    contacts: [
      { id: 'c1', org: 'Yassine', stage: 'new', ownerId: 'u3', courseId: 'f1', value: 2400, schedule: [], createdAt: iso(-3) },
      { id: 'c2', org: 'École', stage: 'rdv', ownerId: 'u4', courseId: 'e1', value: 4800, schedule: [], createdAt: iso(-2) },
      { id: 'c3', org: 'Imen', stage: 'won', ownerId: 'u1x', courseId: 'f1', value: 1200, wonAt: iso(-1), createdAt: iso(-9), schedule: [{ id: 'i1', amount: 600, due: iso(-1), status: 'paid', paidAt: iso(-1), method: 'cash' }, { id: 'i2', amount: 600, due: iso(20), status: 'pending', method: 'cheque' }] },
    ],
    activities: [{ id: 'a1', contactId: 'c1', type: 'call', outcome: 'interested', userId: 'u3', at: iso(-1) }, { id: 'a2', contactId: 'c2', type: 'call', outcome: 'noanswer', userId: 'u4', at: iso(-1) }],
    tasks: [{ id: 'k1', title: 'Rappeler', contactId: 'c1', ownerId: 'u3', due: iso(1), done: false }],
    appointments: [],
  };
  const imp = await api().post('/api/admin/import').set(H(admin)).send({ state });
  assert.equal(imp.status, 200, JSON.stringify(imp.body));
  const s = await api().post('/api/auth/login').send({ email: 'salma@test.tn', password: 'demo1234' });
  assert.equal(s.status, 200, JSON.stringify(s.body));
  sales = s.body.token; salesId = s.body.user.id; karimId = 'u4';
});

test('santé et route inconnue', async () => {
  assert.equal((await api().get('/api/health')).body.ok, true);
  assert.equal((await api().get('/api/nope').set(H(admin))).status, 404);
});

test('prévol CORS : toutes les origines sont autorisées, même si CORS_ORIGINS est défini', async () => {
  const allowed = await api()
    .options('/api/auth/login')
    .set('Origin', 'https://crm-test.vercel.app')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');
  assert.equal(allowed.status, 204);
  assert.equal(allowed.headers['access-control-allow-origin'], '*');

  const anyOrigin = await api()
    .options('/api/auth/login')
    .set('Origin', 'https://untrusted.example')
    .set('Access-Control-Request-Method', 'POST')
    .set('Access-Control-Request-Headers', 'content-type');
  assert.equal(anyOrigin.status, 204);
  assert.equal(anyOrigin.headers['access-control-allow-origin'], '*');
});

test('authentification : mauvais mot de passe, jeton absent, setup déjà fait', async () => {
  assert.equal((await api().post('/api/auth/login').send({ email: 'nour@test.tn', password: 'faux' })).status, 401);
  assert.equal((await api().get('/api/bootstrap')).status, 401);
  assert.equal((await api().post('/api/auth/setup').send({ email: 'x@y.tn', password: 'motdepasse1' })).status, 409);
  const me = await api().get('/api/auth/me').set(H(admin));
  assert.equal(me.body.user.email, 'nour@test.tn');
  assert.equal(me.body.user.passwordHash, undefined);
});

test('bootstrap : le Super admin voit tout, sans mots de passe', async () => {
  const r = await api().get('/api/bootstrap').set(H(admin));
  assert.equal(r.status, 200);
  assert.equal(r.body.state.contacts.length, 3);
  assert.equal(r.body.state.stages.length, 7);
  assert.ok(r.body.state.roles.some((x) => x.id === 'admin'));
  assert.ok(r.body.state.users.every((u) => u.passwordHash === undefined));
  const c3 = r.body.state.contacts.find((c) => c.id === 'c3');
  assert.deepEqual(c3.payment, { status: 'deposit', paid: 600 });
  assert.equal(c3.productTypeId, 't1');
});

test('bootstrap : la commerciale ne voit que SES prospects de SON activité', async () => {
  const r = await api().get('/api/bootstrap').set(H(sales));
  const s = r.body.state;
  assert.deepEqual(s.contacts.map((c) => c.id), ['c1']);
  assert.deepEqual(s.activities.map((a) => a.id), ['a1']);
  assert.deepEqual(s.catalog.map((p) => p.id), ['f1']);
  assert.deepEqual(s.productTypes.map((p) => p.id), ['t1']);
  assert.equal(s.settings.currentUserId, salesId);
  // accès direct par l'API REST : même périmètre
  assert.equal((await api().get('/api/contacts/c2').set(H(sales))).status, 404);
  assert.equal((await api().get('/api/contacts').set(H(sales))).body.total, 1);
});

test('création par la commerciale : responsable et activité imposés', async () => {
  const r = await sync(sales, [{ coll: 'contacts', op: 'upsert', doc: { id: 'n1', org: 'Nouveau', stage: 'new', ownerId: karimId, schedule: [], createdAt: iso() } }]);
  assert.equal(r.body.applied, 1, JSON.stringify(r.body));
  const c = (await api().get('/api/contacts/n1').set(H(sales))).body;
  assert.equal(c.ownerId, salesId);
  assert.equal(c.productTypeId, 't1');
  // activité liée créée dans le même lot
  const a = await sync(sales, [{ coll: 'contacts', op: 'upsert', doc: { id: 'n2', org: 'Lot', stage: 'new', schedule: [] } }, { coll: 'activities', op: 'upsert', doc: { id: 'na', contactId: 'n2', type: 'created', userId: 'u4' } }]);
  assert.equal(a.body.applied, 2);
  assert.equal((await api().get('/api/activities/na').set(H(sales))).body.userId, salesId);
});

test('droits refusés pour la commerciale', async () => {
  assert.equal((await api().delete('/api/contacts/c1').set(H(sales))).status, 403);
  const r = await sync(sales, [
    { coll: 'stages', op: 'upsert', doc: { id: 'x', label: 'Pirate', color: '#000' } },
    { coll: 'roles', op: 'upsert', doc: { id: 'sales', name: 'Commercial', permissions: { 'data.all': true } } },
    { coll: 'catalog', op: 'upsert', doc: { id: 'p9', name: 'Produit', typeId: 't1' } },
    { coll: 'company', op: 'set', doc: { name: 'Pirate' } },
    { coll: 'contacts', op: 'upsert', doc: { id: 'c2', org: 'École volée', stage: 'rdv', ownerId: 'u4', courseId: 'e1', value: 4800 } },
    { coll: 'contacts', op: 'upsert', doc: { id: 'c1', org: 'Yassine', stage: 'new', ownerId: 'u4', courseId: 'f1', value: 2400, schedule: [] } },
    { coll: 'users', op: 'upsert', doc: { id: salesId, name: 'Salma', email: 'salma@test.tn', roleId: 'admin' } },
  ]);
  assert.equal(r.body.applied, 0, JSON.stringify(r.body.results));
  assert.equal(r.body.rejected, 7);
  // préférence personnelle autorisée : activité affichée
  assert.equal((await api().put('/api/me/active-type').set(H(sales)).send({ typeId: 't1' })).status, 200);
});

test('paiements : encaisser oui, planifier non (rôle Commercial) ; total des échéances contrôlé', async () => {
  // la commerciale ne peut pas ajouter d'échéance (payments.plan)
  assert.equal((await api().post('/api/contacts/c1/installments').set(H(sales)).send({ amount: 100, due: iso(5) })).status, 403);
  // l'admin planifie
  const ok = await api().post('/api/contacts/c1/installments').set(H(admin)).send({ amount: 1200, due: iso(5), method: 'cheque' });
  assert.equal(ok.status, 201);
  const iid = ok.body.schedule[0].id;
  // dépasser le total (2400) est refusé
  assert.equal((await api().post('/api/contacts/c1/installments').set(H(admin)).send({ amount: 1300, due: iso(9) })).status, 400);
  // la commerciale encaisse
  const pay = await api().post(`/api/contacts/c1/installments/${iid}/pay`).set(H(sales)).send({});
  assert.equal(pay.status, 200);
  assert.deepEqual(pay.body.payment, { status: 'deposit', paid: 1200 });
});

test('équipe : création avec mot de passe, dernier Super admin protégé', async () => {
  const id = 'u-new';
  const r = await sync(admin, [{ coll: 'users', op: 'upsert', doc: { id, name: 'Ines', email: 'INES@test.tn', roleId: 'sales', productTypeIds: ['t1', 't2'] } }]);
  assert.equal(r.body.applied, 1);
  assert.equal((await api().put(`/api/users/${id}/password`).set(H(admin)).send({ password: 'court' })).status, 400);
  assert.equal((await api().put(`/api/users/${id}/password`).set(H(admin)).send({ password: 'ines-motdepasse' })).status, 200);
  const l = await api().post('/api/auth/login').send({ email: 'ines@test.tn', password: 'ines-motdepasse' });
  assert.equal(l.status, 200);
  const bs = (await api().get('/api/bootstrap').set(H(l.body.token))).body.state;
  assert.equal(bs.productTypes.length, 2);
  // email en double
  assert.equal((await sync(admin, [{ coll: 'users', op: 'upsert', doc: { id: 'dup', name: 'X', email: 'ines@test.tn', roleId: 'sales' } }])).body.rejected, 1);
  // le seul Super admin ne peut pas perdre son rôle
  const me = (await api().get('/api/auth/me').set(H(admin))).body.user;
  const d = await sync(admin, [{ coll: 'users', op: 'upsert', doc: { ...me, roleId: 'sales' } }]);
  assert.equal(d.body.rejected, 1);
  assert.match(d.body.results[0].error, /Super admin/);
  // compte désactivé : plus d'accès
  await sync(admin, [{ coll: 'users', op: 'upsert', doc: { id, name: 'Ines', email: 'ines@test.tn', roleId: 'sales', active: false } }]);
  assert.equal((await api().get('/api/bootstrap').set(H(l.body.token))).status, 403);
});

test('rôles : seul le Super admin les modifie ; le rôle admin est verrouillé', async () => {
  const r = await sync(admin, [{ coll: 'roles', op: 'upsert', doc: { id: 'admin', name: 'Pas admin', permissions: {} } }, { coll: 'roles', op: 'delete', id: 'admin' }]);
  assert.equal(r.body.results[1].ok, false);
  const roles = (await api().get('/api/roles').set(H(admin))).body.items;
  assert.equal(roles.find((x) => x.id === 'admin').name, 'Super admin');
});

test('ordre des colonnes du pipeline', async () => {
  const before = (await api().get('/api/stages').set(H(admin))).body.items.map((s) => s.id);
  const ids = [before[1], before[0], ...before.slice(2)];
  assert.equal((await api().put('/api/stages/order').set(H(admin)).send({ ids })).status, 200);
  assert.deepEqual((await api().get('/api/stages').set(H(admin))).body.items.map((s) => s.id), ids);
  assert.equal((await api().put('/api/stages/order').set(H(sales)).send({ ids: before })).status, 403);
});

test('statistiques : pas de montants pour la commerciale', async () => {
  const a = (await api().get('/api/stats/summary?months=3').set(H(admin))).body;
  assert.equal(a.money, true); assert.ok('revenue' in a.months[2]);
  const s = (await api().get('/api/stats/summary?months=3').set(H(sales))).body;
  assert.equal(s.money, false); assert.equal(s.scope, 'personnel');
  assert.ok(!('revenue' in s.months[2]) && !('won' in s.months[2]));
});

test('IA : 501 sans clé, et montants retirés du contexte', async () => {
  assert.equal((await api().post('/api/ai').set(H(admin)).send({ question: 'test' })).status, 501);
  assert.deepEqual(stripMoney({ mois: [{ mois: '2026-01', revenue: 5, signatures: 2, cashed: 1 }], equipe: [{ nom: 'A', revenue: 3, score: 80 }] }), { mois: [{ mois: '2026-01', signatures: 2 }], equipe: [{ nom: 'A', score: 80 }] });
});

test('SSO : secret obligatoire, membre créé à la volée', async () => {
  assert.equal((await api().post('/api/auth/sso').set('x-sso-secret', 'faux').send({ email: 'sso@test.tn' })).status, 401);
  const r = await api().post('/api/auth/sso').set('x-sso-secret', 'sso-test-secret').send({ email: 'sso@test.tn', name: 'Via SSO', roleId: 'manager', externalId: 'ext-1' });
  assert.equal(r.status, 200);
  assert.equal(r.body.user.roleId, 'manager');
  assert.equal((await api().get('/api/bootstrap').set(H(r.body.token))).body.state.contacts.length >= 3, true);
});

test('multi-entreprises : aucune fuite entre tenants', async () => {
  const b = await api().post('/api/auth/setup').send({ tenantId: 'autre', email: 'boss@autre.tn', password: 'motdepasse2' });
  assert.equal(b.status, 201);
  const s = (await api().get('/api/bootstrap').set(H(b.body.token))).body.state;
  assert.equal(s.contacts.length, 0);
  assert.equal((await api().get('/api/contacts/c1').set(H(b.body.token))).status, 404);
});

test('validation des opérations', async () => {
  assert.equal((await sync(admin, [{ coll: 'hack', op: 'upsert', doc: { id: 'x' } }])).status, 400);
  assert.equal((await sync(admin, [{ coll: 'contacts', op: 'upsert', doc: { org: 'sans id' } }])).status, 400);
  const r = await sync(admin, [{ coll: 'contacts', op: 'upsert', doc: { id: 'bad', stage: 'new' } }]);
  assert.equal(r.body.rejected, 1);
});
