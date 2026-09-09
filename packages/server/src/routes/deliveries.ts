import { Hono } from 'hono';
import { NotFoundError, ValidationError, type DeliveryRepository, type DeliveryStatus } from '@tikuwa/core';
import { readJson } from '../http-utils';
import { env } from '../env';
import { KDNIAO_STATE_LABELS, queryKdniaoTracking, resolveShipperCode } from '../kdniao';

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

  // 記録済みの追跡番号・運送会社を使って快递鳥(kdniao.com)の物流照会APIに問い合わせ、
  // 中国国内の配送が完了(署名確認)していれば上海到着に自動更新する。
  app.post('/:id/track', async (c) => {
    const id = Number(c.req.param('id'));
    const record = repo.findAll().find((d) => d.id === id);
    if (!record) return c.json({ error: 'not_found', message: '記録が見つかりません' }, 404);
    if (!record.carrier) {
      return c.json({ error: 'validation', message: '運送会社が入力されていません' }, 400);
    }
    const shipperCode = resolveShipperCode(record.carrier);
    if (!shipperCode) {
      return c.json(
        { error: 'validation', message: `運送会社「${record.carrier}」に対応する配送業者コードが見つかりません` },
        400
      );
    }
    if (!env.kdniaoEbusinessId || !env.kdniaoAppKey) {
      return c.json(
        {
          error: 'not_configured',
          message: '快递鳥のAPIキーが設定されていません(KDNIAO_EBUSINESS_ID・KDNIAO_APP_KEY)',
        },
        500
      );
    }
    try {
      const result = await queryKdniaoTracking(
        env.kdniaoEbusinessId,
        env.kdniaoAppKey,
        shipperCode,
        record.trackingNumber
      );
      if (!result.Success) {
        return c.json({ error: 'kdniao_error', message: result.Reason || '照会に失敗しました' }, 502);
      }
      let delivery = record;
      if (result.State === '3' && (record.category == null || record.category === '発注済み')) {
        const updateResult = repo.update(id, { category: '上海到着' });
        if (!(updateResult instanceof Error)) delivery = updateResult;
      }
      const traces = result.Traces ?? [];
      return c.json({
        state: result.State ?? null,
        stateText: KDNIAO_STATE_LABELS[result.State ?? ''] ?? '不明',
        latestTrace: traces.length ? traces[traces.length - 1] : null,
        delivery,
      });
    } catch (err) {
      return c.json({ error: 'kdniao_error', message: (err as Error).message }, 502);
    }
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
