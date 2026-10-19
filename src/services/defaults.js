/* Données créées automatiquement pour une nouvelle entreprise (tenant) */
import crypto from 'node:crypto';
import { defaultRoles } from '../shared/permissions.js';

const uid = () => crypto.randomUUID();

export const DEFAULT_STAGES = [
  { id: 'new', label: 'Nouveau lead', color: '#8A90A3' },
  { id: 'contacted', label: 'Contacté', color: '#3B82F6' },
  { id: 'interested', label: 'Intéressé', color: '#F59E0B' },
  { id: 'rdv', label: 'RDV / visite', color: '#7C3AED' },
  { id: 'negotiation', label: 'Pré-inscription', color: '#DB2777' },
  { id: 'won', label: 'Inscrit', color: '#16A34A' },
  { id: 'lost', label: 'Perdu', color: '#DC2626' },
];

export const defaultClauses = () => [
  { id: uid(), title: 'Engagement de paiement intégral', active: true, typeIds: [],
    text: 'Toute commande, inscription ou souscription validée engage {client} au paiement de la totalité du montant convenu ({montant}), y compris en cas d’arrêt, d’abandon ou d’absence avant la date de fin. Aucun remboursement ne sera effectué, sauf accord écrit de {entreprise}.' },
  { id: uid(), title: 'Respect de l’échéancier', active: true, typeIds: [],
    text: 'Les échéances figurant sur cette fiche doivent être honorées aux dates prévues. Tout chèque, traite ou prélèvement impayé rend immédiatement exigible le solde restant dû.' },
  { id: uid(), title: 'Report ou changement de session', active: false, typeIds: [],
    text: 'Un report vers une session ultérieure peut être accordé une seule fois, sur demande écrite au moins 7 jours avant le début. Le montant total reste dû.' },
];

export const DEFAULT_COMPANY = { name: 'Proservices', logo: '', address: '', phone: '', email: '', website: '', taxId: '', footer: '' };
export const DEFAULT_SETTINGS = { dailyCallGoal: 50, weeklyRdvGoal: 10, centerAddress: 'Centre Proservices', rolesV: 2 };

/** Clés de paramètres propres à la session du navigateur : jamais enregistrées côté serveur */
export const CLIENT_ONLY_SETTINGS = ['currentUserId', 'authManaged', 'apiMode', 'session'];

export { defaultRoles };
