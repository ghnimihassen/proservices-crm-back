// Vérifie que les règles d'accès du serveur sont identiques à celles du front
import { readFileSync } from 'node:fs';
const a = readFileSync(new URL('../src/shared/permissions.js', import.meta.url), 'utf8');
const b = readFileSync(new URL('../../frontend/src/crm/store/permissions.js', import.meta.url), 'utf8');
if (a !== b) { console.error('✗ backend/src/shared/permissions.js diffère de frontend/src/crm/store/permissions.js : recopiez le fichier du front.'); process.exit(1); }
console.log('✓ Règles d’accès identiques front / back');
