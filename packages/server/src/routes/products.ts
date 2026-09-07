import { Hono } from 'hono';
import {
  DuplicateBarcodeError,
  NotFoundError,
  ValidationError,
  isLowStock,
  neededQuantity,
  type Product,
  type ProductRepository,
  type ProductWithStatus,
  type TransactionType,
} from '@tikuwa/core';

function serialize(product: Product): ProductWithStatus {
  return {
    ...product,
    needed: neededQuantity(product.currentStock, product.targetStock),
    lowStock: isLowStock(product.currentStock, product.targetStock),
  };
}

type ErrorResult = NotFoundError | DuplicateBarcodeError | ValidationError;

function statusFor(err: ErrorResult): 400 | 404 | 409 {
  if (err instanceof NotFoundError) return 404;
  if (err instanceof DuplicateBarcodeError) return 409;
  return 400;
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function productsRoutes(repo: ProductRepository): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const q = c.req.query('q');
    return c.json(repo.findAll(q).map(serialize));
  });

  app.get('/replenishment', (c) => {
    return c.json(repo.findReplenishmentNeeded().map(serialize));
  });

  app.get('/barcode/:code', (c) => {
    const result = repo.findByBarcode(c.req.param('code'));
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, statusFor(result));
    }
    return c.json(serialize(result));
  });

  app.get('/:id', (c) => {
    const result = repo.findById(Number(c.req.param('id')));
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, statusFor(result));
    }
    return c.json(serialize(result));
  });

  app.post('/', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.create({
      name: String(body.name ?? ''),
      barcode: (body.barcode as string | null) ?? null,
      category: (body.category as string | null) ?? null,
      unit: body.unit as string | undefined,
      targetStock: body.target_stock as number | undefined,
      currentStock: body.current_stock as number | undefined,
      memo: (body.memo as string | null) ?? null,
    });
    if (result instanceof Error) {
      const err = result as ErrorResult;
      return c.json({ error: err.kind, message: err.message }, statusFor(err));
    }
    return c.json(serialize(result), 201);
  });

  app.put('/:id', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.update(Number(c.req.param('id')), {
      name: body.name as string | undefined,
      barcode: body.barcode as string | null | undefined,
      category: body.category as string | null | undefined,
      unit: body.unit as string | undefined,
      targetStock: body.target_stock as number | undefined,
      memo: body.memo as string | null | undefined,
    });
    if (result instanceof Error) {
      const err = result as ErrorResult;
      return c.json({ error: err.kind, message: err.message }, statusFor(err));
    }
    return c.json(serialize(result));
  });

  app.delete('/:id', (c) => {
    const result = repo.remove(Number(c.req.param('id')));
    if (result instanceof NotFoundError) {
      return c.json({ error: result.kind, message: result.message }, statusFor(result));
    }
    return c.body(null, 204);
  });

  app.get('/:id/transactions', (c) => {
    return c.json(repo.listTransactions(Number(c.req.param('id'))));
  });

  app.post('/:id/transactions', async (c) => {
    const body = await readJson(c.req.raw);
    const type = body.type as TransactionType;
    if (!['in', 'out', 'adjust'].includes(type)) {
      const err = new ValidationError('typeはin/out/adjustのいずれかを指定してください');
      return c.json({ error: err.kind, message: err.message }, statusFor(err));
    }
    const result = repo.recordTransaction(Number(c.req.param('id')), {
      type,
      quantity: Number(body.quantity),
      note: (body.note as string | null) ?? null,
    });
    if (result instanceof Error) {
      const err = result as ErrorResult;
      return c.json({ error: err.kind, message: err.message }, statusFor(err));
    }
    return c.json(serialize(result));
  });

  return app;
}
