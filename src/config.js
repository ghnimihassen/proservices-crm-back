import 'dotenv/config';

const env = process.env.NODE_ENV || 'development';
const list = (v, d) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);

export const config = {
  env,
  port: Number(process.env.PORT) || 4000,
  /** 'mongo' (production) ou 'memory' (essai / tests : données perdues à l'arrêt) */
  dbDriver: process.env.DB_DRIVER || (process.env.MONGODB_URI ? 'mongo' : 'memory'),
  mongoUri: process.env.MONGODB_URI || '',
  jwtSecret: process.env.JWT_SECRET || (env === 'production' ? '' : 'dev-secret-a-changer'),
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  corsOrigins: list(process.env.CORS_ORIGINS, 'http://localhost:5173,http://127.0.0.1:5173'),
  defaultTenant: process.env.DEFAULT_TENANT || 'default',
  /** Secret partagé avec votre application pour la connexion unique (SSO) : voir POST /api/auth/sso */
  ssoSecret: process.env.SSO_SECRET || '',
  /** Mot de passe donné aux membres importés sans mot de passe (données de démo) */
  demoPassword: process.env.DEMO_PASSWORD || 'demo1234',
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  jsonLimit: process.env.JSON_LIMIT || '15mb',
  loginRateLimit: Number(process.env.LOGIN_RATE_LIMIT) || 20,
};

export function assertConfig() {
  if (!config.jwtSecret) throw new Error('JWT_SECRET est obligatoire en production.');
  if (config.dbDriver === 'mongo' && !config.mongoUri) throw new Error('MONGODB_URI est obligatoire avec DB_DRIVER=mongo.');
  if (config.env === 'production' && config.dbDriver === 'memory') console.warn('[config] ATTENTION : DB_DRIVER=memory en production, les données seront perdues au redémarrage.');
}
