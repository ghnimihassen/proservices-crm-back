import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import morgan from 'morgan';
import { config } from './config.js';
import { apiRouter } from './routes/crm.js';
import { notFound, errorHandler } from './middleware/index.js';

export function createApp() {
  const app = express();
  const isAllowedOrigin = (origin) => !origin || config.corsOrigins.includes('*') || config.corsOrigins.includes(origin);
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, isAllowedOrigin(origin)),
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-sso-secret'],
  }));
  app.options('*', (req, res, next) => {
    if (!isAllowedOrigin(req.get('origin'))) return res.sendStatus(403);
    return next();
  });
  app.use(express.json({ limit: config.jsonLimit }));
  if (config.env !== 'test') app.use(morgan(config.env === 'production' ? 'combined' : 'dev'));
  app.use('/api', apiRouter());
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
