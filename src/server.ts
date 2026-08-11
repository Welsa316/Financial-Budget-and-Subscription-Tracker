import express from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { resolve } from 'node:path';
import { config, ROOT, validateConfig } from './config.js';
import { closeDb, getDb } from './db.js';
import { forceHttps, purgeExpiredSessions, requireAuth, sameOriginOnly } from './auth.js';
import { router } from './routes.js';
import { startScheduler, stopScheduler } from './sync.js';
import { errorPage } from './views.js';
import { tellerConfigured } from './config.js';

function boot(): void {
  const problems = validateConfig();
  const fatal = problems.filter((problem) => problem.fatal);

  if (fatal.length > 0) {
    console.error('\nCannot start — required configuration is missing:\n');
    for (const problem of fatal) {
      console.error(`  ${problem.key}: ${problem.message}`);
    }
    console.error('\nSee .env.example for the full list.\n');
    process.exit(1);
  }

  for (const problem of problems) {
    console.warn(`[config] ${problem.key}: ${problem.message}`);
  }

  const db = getDb();
  console.log(`[db] ready at ${config.dbPath}`);
  const purged = purgeExpiredSessions();
  if (purged > 0) console.log(`[auth] purged ${purged} expired session(s)`);

  const app = express();

  // Railway terminates TLS one hop in front of us; this makes req.secure and
  // the rate limiter's IP detection correct.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", 'https://cdn.teller.io'],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          frameSrc: ["'self'", 'https://teller.io', 'https://*.teller.io'],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: config.isProduction ? [] : null,
        },
      },
      hsts: config.isProduction ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'same-origin' },
    }),
  );

  app.use(forceHttps);
  app.use(express.urlencoded({ extended: false, limit: '256kb' }));
  app.use(express.json({ limit: '4mb' })); // statement import posts batches
  app.use(cookieParser());
  app.use(sameOriginOnly);

  app.use(
    '/static',
    express.static(resolve(ROOT, 'public'), {
      maxAge: config.isProduction ? '1h' : 0,
      index: false,
    }),
  );
  app.use(
    '/icons',
    express.static(resolve(ROOT, 'public', 'icons'), {
      maxAge: config.isProduction ? '7d' : 0,
      index: false,
    }),
  );
  app.get('/manifest.json', (_req, res) => {
    res.sendFile(resolve(ROOT, 'public', 'manifest.json'));
  });
  app.get('/sw.js', (_req, res) => {
    res.type('application/javascript').sendFile(resolve(ROOT, 'public', 'sw.js'));
  });

  app.use(requireAuth);
  app.use(router);

  app.use(
    (
      error: Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ): void => {
      console.error('[error]', error);
      if (res.headersSent) return;
      res.status(500).type('html').send(errorPage(500, 'Something went wrong.'));
    },
  );

  const server = app.listen(config.port, () => {
    console.log(`[web] listening on :${config.port} (${config.nodeEnv})`);
    console.log(`[web] timezone ${config.timezone}`);
    if (tellerConfigured()) {
      startScheduler();
    } else {
      console.log('[sync] scheduler not started — Teller credentials missing');
    }
  });

  // Without this a bind failure is an unhandled 'error' event that kills the
  // process with no usable message.
  server.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`[web] port ${config.port} is already in use`);
    } else {
      console.error('[web] server error', error);
    }
    process.exit(1);
  });

  const shutdown = (signal: string): void => {
    console.log(`[web] ${signal} received, shutting down`);
    stopScheduler();
    server.close(() => {
      closeDb();
      process.exit(0);
    });
    // Railway sends SIGTERM then SIGKILL; do not hang past that window.
    setTimeout(() => process.exit(0), 8000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  void db;
}

boot();
