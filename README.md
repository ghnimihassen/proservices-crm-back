# API du CRM Proservices — Node.js / Express / MongoDB

Backend du CRM : authentification, rôles et droits, cloisonnement des données (par commercial et par activité),
toutes les écritures du CRM, import / export, statistiques, assistant IA. **Les mêmes règles d'accès que l'interface
sont appliquées côté serveur** : un commercial ne reçoit jamais les prospects, produits ou montants qu'il n'a pas
le droit de voir, même en appelant l'API directement.

## 1. Démarrer

```bash
cd backend
npm install
cp .env.example .env      # puis renseignez MONGODB_URI et JWT_SECRET
npm run dev               # http://localhost:4000/api
```

### La connexion MongoDB (la seule chose qui reste à faire)

Dans `.env` :

```
MONGODB_URI=mongodb://localhost:27017/proservices_crm
# ou MongoDB Atlas :
MONGODB_URI=mongodb+srv://utilisateur:motdepasse@cluster0.xxxxx.mongodb.net/proservices_crm
```

C'est tout : la connexion est dans `src/db/connect.js`, les modèles dans `src/models/index.js`, et les collections
et index sont créés au premier démarrage. Le premier Super admin est créé automatiquement à partir de
`ADMIN_EMAIL` / `ADMIN_PASSWORD` (ou depuis l'écran « Installation du CRM » au premier lancement du front).

> Sans `MONGODB_URI`, l'API démarre en **mode mémoire** (`DB_DRIVER=memory`) : pratique pour essayer et pour les
> tests, mais les données sont perdues à l'arrêt. Avec Docker : `docker compose up -d` à la racine lance MongoDB + l'API.

### Brancher le front

```bash
cd frontend
echo "VITE_API_URL=http://localhost:4000/api" > .env
npm run dev               # http://localhost:5173 → écran de connexion
```

Dans votre propre application React : `<ProservicesCRM apiUrl="https://votre-serveur/api" />` (voir le README du front).

## 2. Architecture

```
backend/
  src/
    server.js            démarrage (lit .env, connecte la base, lance Express)
    app.js               Express : sécurité (helmet, CORS, limite de débit), JSON, routes, erreurs
    config.js            toutes les variables d'environnement
    db/connect.js        ← connexion MongoDB (Mongoose)
    db/repository.js     accès aux données : MongoRepository (production) / MemoryRepository (tests)
    models/index.js      schémas Mongoose : users, roles, contacts, activities, appointments, tasks,
                         products, product_types, guides, stages, clauses, singletons (company, settings)
    shared/permissions.js  règles d'accès — copie EXACTE de frontend/src/crm/store/permissions.js
    services/
      auth.js            connexion, jeton JWT, première installation, SSO
      context.js         utilisateur connecté + droits, création des données de base d'une entreprise
      scope.js           périmètre de lecture (prospects visibles, activités autorisées…)
      ops.js             TOUTES les écritures : droits, périmètre, règles métier, normalisation
      importer.js        import d'un état complet (sauvegarde, démo)
      stats.js           indicateurs agrégés
      ai.js              assistant IA (API Claude), montants retirés si l'utilisateur n'y a pas droit
    routes/crm.js        auth, bootstrap, sync, admin, opérations métier, stats, IA
    routes/resources.js  REST générique par ressource
  scripts/seed.js        initialisation (Super admin) : ADMIN_EMAIL=… ADMIN_PASSWORD=… npm run seed
  test/api.test.js       15 tests de bout en bout (npm test)
```

**Un seul point d'écriture** : `services/ops.js → applyOps()`. La synchronisation du CRM et les routes REST
fabriquent les mêmes « opérations », donc les mêmes contrôles s'appliquent partout.

**Multi-entreprises** : chaque document porte un `tenantId` (dans le jeton). Une base peut servir plusieurs
entreprises clientes sans fuite de données (`tenantId` à passer au login et au composant React).

## 3. Référence de l'API

Toutes les routes sont préfixées par `/api`. Sauf mention contraire, elles demandent l'en-tête
`Authorization: Bearer <token>`. Erreurs : `{ "error": "message", "code": "forbidden|invalid|not_found|unauthorized|…" }`.

### Authentification

| Méthode | Route | Description |
|---|---|---|
| POST | `/auth/login` | `{ email, password, tenantId? }` → `{ token, user, tenantId }` (sans jeton, limité en débit) |
| GET | `/auth/setup` | `{ needed: true }` si aucun membre n'existe encore (sans jeton) |
| POST | `/auth/setup` | `{ name, email, password }` crée le 1er Super admin (refusé ensuite) |
| POST | `/auth/sso` | Depuis **votre backend** : en-tête `x-sso-secret`, `{ email, name, externalId?, roleId?, productTypeIds? }` → jeton CRM |
| GET | `/auth/me` | Utilisateur connecté |
| POST | `/auth/password` | `{ current, password }` changer son mot de passe |

### CRM (utilisé par le front React)

| Méthode | Route | Description |
|---|---|---|
| GET | `/bootstrap` | Toutes les données **visibles par l'utilisateur**, au format de l'état du CRM |
| POST | `/sync` | `{ ops: [...] }` applique les modifications ; réponse `{ results: [{ ok, error? }], applied, rejected }` |
| POST | `/admin/import` | Super admin : `{ state, mode: 'replace' \| 'merge' }` (sauvegarde JSON, données de démo, migration depuis le navigateur) |
| GET | `/admin/export` | Super admin : export JSON complet |

Opérations de `/sync` : `{ coll, op: 'upsert', doc }`, `{ coll, op: 'delete', id }`, `{ coll, op: 'order', ids }`
(stages, clauses, productTypes, catalog, guides), `{ coll: 'company' | 'settings', op: 'set', doc }`.

### Ressources REST

Pour chaque ressource : `GET /x` (filtres par champ, `q` = recherche, `page`, `limit` ≤ 500, `sort=-champ`,
`updatedSince`), `GET /x/:id`, `POST /x`, `PUT /x/:id`, `PATCH /x/:id`, `DELETE /x/:id`.

| Ressource | Filtres | Droits d'écriture |
|---|---|---|
| `contacts` | stage, ownerId, productTypeId, courseId, source, type, city | create / edit / delete / assign ; échéancier : payments.plan / payments.collect |
| `activities` | contactId, type, userId, outcome | prospect visible ; modification de ses propres activités |
| `appointments` | contactId, ownerId, status, mode | prospect visible ou les siens |
| `tasks` | contactId, ownerId, type, priority, done | prospect visible ou les siennes |
| `products` | typeId, category, active | products.manage |
| `product-types` | — | products.manage |
| `guides` | — | guides.manage |
| `stages` | — | pipeline.configure (`won` et `lost` obligatoires) |
| `clauses` | active | clauses.manage |
| `users` | roleId, active | team.manage (rôle Super admin : seulement par un Super admin ; il en reste toujours un) |
| `roles` | — | Super admin uniquement ; le rôle `admin` est verrouillé |

Routes ordonnées : `PUT /stages/order`, `/clauses/order`, `/product-types/order`, `/products/order`, `/guides/order` avec `{ ids }`.

### Opérations métier

| Méthode | Route | Description |
|---|---|---|
| POST | `/contacts/import` | `{ contacts: [...] }` (jusqu'à 5 000) |
| PATCH | `/contacts/bulk` | `{ ids, patch }` |
| GET | `/contacts/:id/timeline` | Activités, RDV et tâches du prospect |
| POST | `/contacts/:id/installments` | `{ method, amount, due, ref?, bank? }` — refusé si le total dépasse le montant |
| PATCH / DELETE | `/contacts/:id/installments/:iid` | Modifier / supprimer une échéance |
| POST | `/contacts/:id/installments/:iid/pay` | `{ paid: true \| false }` encaisser / annuler |
| POST | `/contacts/:id/payments` | `{ amount, method, ref? }` encaissement libre |
| PUT | `/users/:id/password` | `{ password }` (team.manage) |
| PUT | `/me/active-type` | `{ typeId }` activité affichée (Formations, Erudaxis…) |
| GET / PUT | `/company`, `/settings` | Profil de l'entreprise (company.manage), objectifs (team.manage) |
| GET | `/stats/summary?months=12` | Totaux par mois ; montants seulement avec finance.view, chiffres de l'entreprise seulement avec reports.company |
| POST | `/ai` | `{ question, context, role }` → `{ answer }` (501 si `ANTHROPIC_API_KEY` absent) |
| GET | `/health` | État du serveur (sans jeton) |

### Exemple

```bash
TOKEN=$(curl -s -X POST localhost:4000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@proservices.tn","password":"ChangezMoi2026"}' | jq -r .token)

curl -s localhost:4000/api/contacts?stage=rdv\&limit=20 -H "Authorization: Bearer $TOKEN"
curl -s -X POST localhost:4000/api/contacts -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"org":"Société X","phone":"+216 71 000 000","source":"Site web","courseId":"f1","value":2400}'
```

## 4. Connexion unique avec votre application

Si vos utilisateurs sont déjà connectés dans votre solution :

1. Définissez `SSO_SECRET` dans le `.env` du CRM.
2. Votre backend appelle `POST /api/auth/sso` (en-tête `x-sso-secret`) avec l'utilisateur connecté
   (`email`, `name`, `externalId`, et si besoin `roleId` / `productTypeIds`). Le membre est créé ou mis à jour.
3. Passez le jeton reçu au composant : `<ProservicesCRM apiUrl="…/api" token={token} />` (pas d'écran de connexion).

Ne mettez jamais `SSO_SECRET` ni `ANTHROPIC_API_KEY` dans le code du navigateur.

## 5. Tests

```bash
npm test                 # 15 tests : auth, périmètre, droits refusés, paiements, équipe, rôles, SSO, multi-entreprises…
npm run check:shared     # vérifie que les règles d'accès front et back sont identiques
```

Les tests utilisent la base en mémoire ; les mêmes services tournent sur MongoDB en production.
