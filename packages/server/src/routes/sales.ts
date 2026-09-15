import { Hono } from 'hono';
import { NotFoundError, ValidationError, type SalePlatform, type SaleRepository } from '@tikuwa/core';
import { readJson } from '../http-utils';
import iconv from 'iconv-lite';
import { buildFreewayKeiriCsv, FREEWAY_KEIRI_EXPORT_FILENAME } from '../freeway-keiri-export';

export function salesRoutes(repo: SaleRepository): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    return c.json(repo.findAll());
  });

  // 流水記録をフリーウェイ経理(Lite)に取り込める仕訳データCSV(Shift-JIS)として書き出す。
  // ?q=検索語 ?platform=プラットフォーム で、一覧画面の絞り込みと同じ条件に対応する。
  app.get('/export/freeway-keiri', (c) => {
    let sales = repo.findAll();
    const q = c.req.query('q')?.trim().toLowerCase();
    if (q) {
      sales = sales.filter(
        (s) =>
          s.productName.toLowerCase().includes(q) ||
          s.platform.toLowerCase().includes(q) ||
          (s.memo ?? '').toLowerCase().includes(q)
      );
    }
    const platform = c.req.query('platform');
    if (platform) sales = sales.filter((s) => s.platform === platform);

    const csv = buildFreewayKeiriCsv(sales);
    const buffer = Uint8Array.from(iconv.encode(csv, 'Shift_JIS'));
    c.header('Content-Type', 'text/csv');
    c.header('Content-Disposition', `attachment; filename="${FREEWAY_KEIRI_EXPORT_FILENAME}"`);
    return c.body(buffer);
  });

  app.post('/', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.create({
      platform: String(body.platform ?? '') as SalePlatform,
      productName: String(body.product_name ?? ''),
      saleDate: String(body.sale_date ?? ''),
      saleAmount: Number(body.sale_amount ?? 0),
      fee: body.fee !== undefined ? Number(body.fee) : undefined,
      shippingCost: body.shipping_cost !== undefined ? Number(body.shipping_cost) : undefined,
      memo: body.memo != null ? String(body.memo) : null,
    });
    if (result instanceof ValidationError) {
      return c.json({ error: result.kind, message: result.message }, 400);
    }
    return c.json(result, 201);
  });

  app.put('/:id', async (c) => {
    const body = await readJson(c.req.raw);
    const result = repo.update(Number(c.req.param('id')), {
      platform: body.platform as SalePlatform | undefined,
      productName: body.product_name as string | undefined,
      saleDate: body.sale_date as string | undefined,
      saleAmount: body.sale_amount !== undefined ? Number(body.sale_amount) : undefined,
      fee: body.fee !== undefined ? Number(body.fee) : undefined,
      shippingCost: body.shipping_cost !== undefined ? Number(body.shipping_cost) : undefined,
      memo: body.memo as string | null | undefined,
    });
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
