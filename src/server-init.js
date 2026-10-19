import { config } from './config.js';
import { setRepository, MongoRepository, MemoryRepository } from './db/repository.js';
import { connectMongo } from './db/connect.js';

export async function initDatabase() {
  if (config.dbDriver === 'mongo') {
    await connectMongo(config.mongoUri);
    setRepository(new MongoRepository());
  } else {
    setRepository(new MemoryRepository());
    console.warn('[db] Mode mémoire (DB_DRIVER=memory) : pratique pour essayer, mais les données sont perdues à l’arrêt. Renseignez MONGODB_URI pour MongoDB.');
  }
}
