import { Hono } from 'hono';
import { NotFoundError, ValidationError, type DeliveryRepository, type DeliveryStatus } from '@tikuwa/core';
import { readJson } from '../http-utils';

export function deliveriesRoutes(repo: DeliveryRepository): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(repo.findAll());
  });

  app.post('/', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.create({
      productName: String(body.product_name ?? ''),
      trackingNumber: String(body.tracking_number ?? ''),
      carrier: body.carrier != null ? String(body.carrier) : null,
      category: body.category != null ? String(body.category) : null,
      internationalTrackingNumber:
        body.international_tracking_number != null ? String(body.international_tracking_number) : null,
    });
    if (result instanceof ValidationError) {
      return c.json({ error: result.kind, message: result.message }, 400);
    }
    return c.json(result, 201);
  });

  app.put('/:id', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.update(Number(c.req.param('id')), {
      productName: body.product_name as string | undefined,
      trackingNumber: body.tracking_number as string | undefined,
      carrier: body.carrier as string | null | undefined,
      category: body.category as string | null | undefined,
      internationalTrackingNumber: body.international_tracking_number as string | null | undefined,
    });
    if (result instanceof ValidationError) {
      return c.json({ error: result.kind, message: result.message }, 400);
    }
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, 404);
    }
    return c.json(result);
  });

  app.patch('/:id/status', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.updateStatus(Number(c.req.param('id')), String(body.status ?? '') as DeliveryStatus);
    if (result instanceof ValidationError) {
      return c.json({ error: result.kind, message: result.message }, 400);
    }
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, 404);
    }
    return c.json(result);
  });

  app.delete('/:id', (c) => {
    const result = repo.remove(Number(c.req.param('id')));
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, 404);
    }
    return c.body(null, 204);
  });

  return app;
}
