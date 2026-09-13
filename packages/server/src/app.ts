import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import type { DeliveryRepository, ProductRepository, SaleRepository } from '@tikuwa/core';
import { productsRoutes } from './routes/products';
import { deliveriesRoutes } from './routes/deliveries';
import { salesRoutes } from './routes/sales';

export function createApp(
  productRepo: ProductRepository,
  deliveryRepo: DeliveryRepository,
  saleRepo: SaleRepository,
  webPublicDir: string
): Hono {
  const app = new Hono();

  app.route('/api/products', productsRoutes(productRepo));
  app.route('/api/deliveries', deliveriesRoutes(deliveryRepo));
  app.route('/api/sales', salesRoutes(saleRepo));
  app.use('/*', serveStatic({ root: webPublicDir }));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}
