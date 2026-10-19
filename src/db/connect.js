/*
 * ===== Connexion MongoDB =====
 * C'est le seul point à configurer : renseignez MONGODB_URI dans le fichier .env, par exemple
 *   MONGODB_URI=mongodb://localhost:27017/proservices_crm
 *   MONGODB_URI=mongodb+srv://utilisateur:motdepasse@cluster0.xxxxx.mongodb.net/proservices_crm
 * Les collections et les index sont créés automatiquement au premier démarrage.
 */
import mongoose from 'mongoose';
import { syncIndexes } from '../models/index.js';

export async function connectMongo(uri) {
  mongoose.set('strictQuery', true);
  mongoose.connection.on('error', (e) => console.error('[mongo] erreur :', e.message));
  mongoose.connection.on('disconnected', () => console.warn('[mongo] déconnecté'));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000, maxPoolSize: 20 });
  await syncIndexes();
  console.log(`[mongo] connecté à ${mongoose.connection.host}/${mongoose.connection.name}`);
}

export async function disconnectMongo() {
  await mongoose.disconnect();
}

export const mongoReady = () => mongoose.connection.readyState === 1;
