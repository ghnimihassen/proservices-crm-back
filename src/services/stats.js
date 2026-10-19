/*
 * Indicateurs agrégés côté serveur (pour vos autres outils : BI, appli mobile, e-mails de synthèse…).
 * Le CRM React calcule ses tableaux de bord dans le navigateur à partir des données déjà filtrées ;
 * cette route donne les mêmes totaux sans charger toutes les données.
 * Périmètre : celui de l'utilisateur. Montants seulement avec « finance.view ». Volumes de l'entreprise
 * seulement avec « reports.company » (sinon : ses propres chiffres).
 */
import { db } from '../db/repository.js';
import { contactFilter } from './scope.js';

const t = (d) => (d ? new Date(d).getTime() : NaN);
const isReached = (a) => a.type === 'call' && a.outcome && a.outcome !== 'noanswer';
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export async function summary(ctx, { months = 12 } = {}) {
  const repo = db(); const tid = ctx.tenantId;
  const money = ctx.can('finance.view');
  const company = ctx.can('reports.company');
  const filter = company ? contactFilter(ctx) : { ...contactFilter(ctx), ownerId: ctx.user.id };
  const contacts = await repo.list('contacts', tid, filter);
  const ids = new Set(contacts.map((c) => c.id));
  const calls = (await repo.list('activities', tid, { type: 'call', ...(company ? {} : { userId: ctx.user.id }) })).filter((a) => !a.contactId || ids.has(a.contactId));
  const now = new Date();
  const rows = Array.from({ length: Math.min(36, Math.max(1, months)) }, (_, i) => {
    const from = new Date(now.getFullYear(), now.getMonth() - (months - 1 - i), 1).getTime();
    const to = new Date(now.getFullYear(), now.getMonth() - (months - 2 - i), 1).getTime();
    const won = contacts.filter((c) => c.stage === 'won' && t(c.wonAt) >= from && t(c.wonAt) < to);
    const lost = contacts.filter((c) => c.stage === 'lost' && t(c.lostAt || c.updatedAt) >= from && t(c.lostAt || c.updatedAt) < to);
    const mc = calls.filter((a) => t(a.at) >= from && t(a.at) < to);
    const row = {
      month: new Date(from).toISOString().slice(0, 7),
      calls: mc.length, reachRate: pct(mc.filter(isReached).length, mc.length), winRate: pct(won.length, won.length + lost.length),
    };
    if (company) Object.assign(row, { leads: contacts.filter((c) => t(c.createdAt) >= from && t(c.createdAt) < to).length, won: won.length, lost: lost.length });
    if (money) {
      row.revenue = won.reduce((s, c) => s + (Number(c.value) || 0), 0);
      row.cashed = contacts.flatMap((c) => c.schedule || []).filter((i) => i.status === 'paid' && t(i.paidAt) >= from && t(i.paidAt) < to).reduce((s, i) => s + (Number(i.amount) || 0), 0);
    }
    return row;
  });
  return { scope: company ? 'entreprise' : 'personnel', money, months: rows };
}
