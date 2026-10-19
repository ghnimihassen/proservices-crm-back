/*
 * Assistant IA : relaie la question et le résumé chiffré vers l'API Claude (Anthropic).
 * Activé seulement si ANTHROPIC_API_KEY est défini. La clé reste sur le serveur.
 * Par sécurité, les montants sont retirés du contexte si l'utilisateur n'a pas le droit « finance.view »,
 * même si le navigateur les a envoyés.
 */
import { config } from '../config.js';
import { HttpError } from './context.js';

const MONEY = /revenue|^rev|cash|value|valeur|^ca$|paid|billed|montant|bas$|haut$|prix|price|amount/i;
export function stripMoney(x) {
  if (Array.isArray(x)) return x.map(stripMoney);
  if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).filter(([k]) => !MONEY.test(k)).map(([k, v]) => [k, stripMoney(v)]));
  return x;
}

const SYSTEM = (role, money) => `Tu es l'analyste commercial du CRM de l'entreprise. Tu réponds en français, de façon concise et actionnable (puces, chiffres clés, recommandations).
Tu t'adresses à ${role === 'direction' ? 'la direction commerciale' : 'un commercial, à propos de ses propres performances'}.
Base-toi uniquement sur les données JSON fournies ; si une information manque, dis-le.${money ? ' Les montants sont en dinars tunisiens (DT).' : ' Ne mentionne aucun montant, chiffre d’affaires ou volume global de prospects ou de clients.'}`;

export async function askAI(ctx, { question, context, role }) {
  if (!config.anthropicKey) throw new HttpError(501, 'IA non configurée sur le serveur (ANTHROPIC_API_KEY)', 'ai_not_configured');
  const q = String(question || '').slice(0, 2000).trim();
  if (!q) throw new HttpError(400, 'Question vide', 'invalid');
  const money = ctx.can('finance.view');
  const exec = ctx.can('reports.company');
  const safeRole = exec && role === 'direction' ? 'direction' : 'commercial';
  const data = money ? context : stripMoney(context);
  const body = JSON.stringify(data ?? {}).slice(0, 60000);
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.anthropicKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: config.anthropicModel, max_tokens: 900, system: SYSTEM(safeRole, money),
      messages: [{ role: 'user', content: `Données du CRM :\n${body}\n\nQuestion : ${q}` }],
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new HttpError(502, `Erreur du service d'IA (${r.status}) ${t.slice(0, 200)}`, 'ai_error'); }
  const j = await r.json();
  return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}
