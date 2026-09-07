import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { ProductRepository } from '@tikuwa/core';
import { productsRoutes } from './routes/products';

export function createApp(repo: ProductRepository, webPublicDir: string): Hono {
  const app = new Hono();

  app.route('/api/products', productsRoutes(repo));
  app.use('/*', serveStatic({ root: webPublicDir }));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
