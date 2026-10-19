/*
 * Rôles et droits d'accès.
 * Chaque rôle a une liste de permissions (clé → true/false).
 * Le rôle « admin » (Super admin) a toujours tous les droits et ne peut pas être modifié ni supprimé.
 */

export const PERMISSION_GROUPS = [
  {
    id: 'nav', title: 'Menus visibles', hint: 'Les entrées du menu de gauche que le rôle peut ouvrir',
    items: [
      { key: 'nav.dashboard', label: 'Tableau de bord' },
      { key: 'nav.contacts', label: 'Prospects' },
      { key: 'nav.calls', label: 'Session d’appels' },
      { key: 'nav.pipeline', label: 'Pipeline' },
      { key: 'nav.rdv', label: 'Rendez-vous' },
      { key: 'nav.tasks', label: 'Tâches & relances' },
      { key: 'nav.products', label: 'Produits' },
      { key: 'nav.guides', label: 'Guides d’appel' },
      { key: 'nav.clients', label: 'Inscrits / clients' },
      { key: 'nav.reports', label: 'Rapports' },
      { key: 'nav.company', label: 'Mon entreprise' },
      { key: 'nav.clauses', label: 'Conditions générales' },
      { key: 'nav.team', label: 'Équipe & paramètres' },
    ],
  },
  {
    id: 'data', title: 'Périmètre des données', hint: 'Sans ce droit, l’utilisateur ne voit que ses propres prospects, RDV et tâches',
    items: [{ key: 'data.all', label: 'Voir les prospects de toute l’équipe' }],
  },
  {
    id: 'contacts', title: 'Prospects',
    items: [
      { key: 'contacts.create', label: 'Ajouter des prospects' },
      { key: 'contacts.edit', label: 'Modifier les prospects' },
      { key: 'contacts.delete', label: 'Supprimer des prospects' },
      { key: 'contacts.import', label: 'Importer (Excel / Sheets)' },
      { key: 'contacts.export', label: 'Exporter' },
      { key: 'contacts.assign', label: 'Réassigner à un autre commercial' },
    ],
  },
  {
    id: 'payments', title: 'Paiements',
    items: [
      { key: 'payments.collect', label: 'Encaisser des paiements' },
      { key: 'payments.plan', label: 'Planifier / modifier l’échéancier' },
    ],
  },
  {
    id: 'pilotage', title: 'Pilotage et chiffres', hint: 'Sans ces droits, le tableau de bord et les rapports n’affichent que les indicateurs personnels (taux, activité), sans montants',
    items: [
      { key: 'reports.company', label: 'KPI de l’entreprise, analyse IA, efficacité de l’équipe et recommandations produits' },
      { key: 'finance.view', label: 'Voir les montants : CA, encaissements, prévisions financières, valeur du pipeline' },
    ],
  },
  {
    id: 'config', title: 'Paramétrage',
    items: [
      { key: 'products.manage', label: 'Gérer les produits et types' },
      { key: 'guides.manage', label: 'Gérer les guides d’appel' },
      { key: 'pipeline.configure', label: 'Configurer les colonnes du pipeline' },
      { key: 'clauses.manage', label: 'Gérer les conditions générales' },
      { key: 'company.manage', label: 'Modifier le profil de l’entreprise' },
      { key: 'team.manage', label: 'Ajouter / modifier les membres de l’équipe' },
    ],
  },
];

export const ALL_PERMISSIONS = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.key));
const pick = (keys) => Object.fromEntries(ALL_PERMISSIONS.map((k) => [k, keys.includes(k)]));

export const ADMIN_ROLE_ID = 'admin';

export const defaultRoles = () => [
  { id: ADMIN_ROLE_ID, name: 'Super admin', description: 'Tous les droits, y compris les rôles et accès', locked: true, permissions: pick(ALL_PERMISSIONS) },
  {
    id: 'manager', name: 'Responsable commercial', description: 'Pilote l’équipe : voit tout, configure le pipeline et les produits',
    permissions: pick(ALL_PERMISSIONS.filter((k) => !['nav.company', 'company.manage', 'clauses.manage', 'nav.team', 'team.manage'].includes(k))),
  },
  {
    id: 'sales', name: 'Commercial', description: 'Travaille ses propres prospects : appels, RDV, encaissements',
    permissions: pick(['nav.dashboard', 'nav.contacts', 'nav.calls', 'nav.pipeline', 'nav.rdv', 'nav.tasks', 'nav.products', 'nav.guides', 'nav.clients', 'nav.reports',
      'contacts.create', 'contacts.edit', 'contacts.export', 'payments.collect']),
  },
];

/** Page d'accueil du rôle : la première page autorisée */
export const NAV_ROUTES = [
  ['nav.dashboard', '/'], ['nav.contacts', '/contacts'], ['nav.pipeline', '/pipeline'], ['nav.calls', '/appels'], ['nav.rdv', '/rendez-vous'],
  ['nav.tasks', '/taches'], ['nav.clients', '/clients'], ['nav.products', '/produits'], ['nav.guides', '/guides'], ['nav.reports', '/rapports'],
  ['nav.company', '/entreprise'], ['nav.clauses', '/conditions'], ['nav.team', '/equipe'],
];

export const currentUser = (state) => state.users.find((u) => u.id === state.settings.currentUserId) || state.users[0];
export const roleById = (state, id) => (state.roles || []).find((r) => r.id === id);
export const roleOf = (state, user) => roleById(state, user?.roleId) || roleById(state, 'sales') || (state.roles || [])[0];
export const isSuperAdmin = (state, user = currentUser(state)) => user?.roleId === ADMIN_ROLE_ID;

/** Le droit `key` est-il accordé à l'utilisateur connecté ? */
export function can(state, key, user = currentUser(state)) {
  if (!user || user.active === false) return false; // compte désactivé : aucun accès
  if (user.roleId === ADMIN_ROLE_ID) return true;
  return !!roleOf(state, user)?.permissions?.[key];
}

/** Prospects visibles par l'utilisateur connecté (tous, ou seulement les siens) */
export const visibleContacts = (state) => scopedState(state).contacts;
export const canSeeContact = (state, c) => !!c && scopedState(state).contacts.some((x) => x.id === c.id);
export const homeRoute = (state) => (NAV_ROUTES.find(([k]) => can(state, k)) || [null, null])[1];

/* ---------- Activités (types de produits) ----------
 * Chaque membre peut être limité à certains types de produits (ex. « Formations », « Erudaxis ») :
 * users[].productTypeIds = [] → toutes les activités ; ['t2'] → seulement Erudaxis.
 * users[].activeTypeId = activité affichée en ce moment ('' = toutes celles autorisées).
 */

/** Type de produit d'un prospect : celui du produit choisi, sinon celui choisi sur la fiche */
export function contactTypeId(state, c) {
  if (c?.courseId) { const p = (state.catalog || []).find((x) => x.id === c.courseId); if (p?.typeId) return p.typeId; }
  return c?.productTypeId || '';
}

/** Activités autorisées pour l'utilisateur : null = toutes */
export function allowedTypeIds(state, user = currentUser(state)) {
  if (!user || user.roleId === ADMIN_ROLE_ID) return null;
  const ids = (user.productTypeIds || []).filter((id) => (state.productTypes || []).some((t) => t.id === id));
  return ids.length ? ids : null;
}

/** Types de produits entre lesquels l'utilisateur peut basculer */
export const switchableTypes = (state, user = currentUser(state)) => {
  const allowed = allowedTypeIds(state, user);
  return (state.productTypes || []).filter((t) => !allowed || allowed.includes(t.id));
};

/** Activité affichée : '' = toutes celles autorisées */
export function activeTypeId(state, user = currentUser(state)) {
  const list = switchableTypes(state, user);
  if (list.length === 1) return list[0].id;
  const a = user?.activeTypeId;
  return a && list.some((t) => t.id === a) ? a : '';
}

/** Types visibles en ce moment : null = tous */
export function effectiveTypeIds(state, user = currentUser(state)) {
  const a = activeTypeId(state, user);
  if (a) return [a];
  return allowedTypeIds(state, user);
}

/** Activité à donner par défaut à un nouveau prospect */
export const defaultTypeId = (state) => activeTypeId(state) || '';

/**
 * Vue des données limitée au périmètre de l'utilisateur :
 * - sans « data.all », seulement ses prospects, ses RDV/tâches et ceux liés à ses prospects ;
 * - seulement les activités (types de produits) autorisées / sélectionnées : prospects, produits, guides, RDV, tâches.
 */
const scopedCache = new WeakMap();
export function scopedState(state) {
  if (scopedCache.has(state)) return scopedCache.get(state);
  const all = can(state, 'data.all');
  const types = effectiveTypeIds(state);
  if (all && !types) { scopedCache.set(state, state); return state; }
  const me = state.settings.currentUserId;
  const typeOk = (id) => !types || types.includes(id);
  const contacts = state.contacts.filter((c) => (all || c.ownerId === me) && typeOk(contactTypeId(state, c)));
  const mine = new Set(contacts.map((c) => c.id));
  const linkedOk = (x) => (x.contactId ? mine.has(x.contactId) : (all || x.ownerId === me));
  const catalog = (state.catalog || []).filter((p) => typeOk(p.typeId));
  const prodIds = new Set(catalog.map((p) => p.id));
  const out = {
    ...state,
    contacts,
    appointments: state.appointments.filter(linkedOk),
    tasks: state.tasks.filter(linkedOk),
    activities: state.activities.filter((a) => (a.contactId ? mine.has(a.contactId) : true)),
    catalog,
    productTypes: (state.productTypes || []).filter((t) => typeOk(t.id)),
    guides: (state.guides || []).filter((g) => !(g.productIds || []).length || g.productIds.some((id) => prodIds.has(id))),
  };
  scopedCache.set(state, out);
  return out;
}
