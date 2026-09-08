import type { DatabaseSync } from 'node:sqlite';
import {
  NotFoundError,
  ValidationError,
  DELIVERY_STATUSES,
  type DeliveryRepository,
  type DeliveryRecord,
  type DeliveryStatus,
  type NewDeliveryRecordInput,
} from '@tikuwa/core';

interface DeliveryRow {
  id: number;
  product_name: string;
  tracking_number: string;
  status: string;
  carrier: string | null;
  created_at: string;
}

function toDelivery(row: DeliveryRow): DeliveryRecord {
  return {
    id: row.id,
    productName: row.product_name,
    trackingNumber: row.tracking_number,
    carrier: row.carrier,
    status: row.status as DeliveryStatus,
    createdAt: row.created_at,
  };
}

function asRow<T>(value: unknown): T {
  return value as T;
}

export function SqliteDeliveryRepository(db: DatabaseSync): DeliveryRepository {
  const findAll: DeliveryRepository['findAll'] = () => {
    return asRow<DeliveryRow[]>(
      db.prepare('SELECT * FROM delivery_records ORDER BY created_at DESC, id DESC').all()
    ).map(toDelivery);
  };

  const create: DeliveryRepository['create'] = (input: NewDeliveryRecordInput) => {
    const productName = input.productName.trim();
    const trackingNumber = input.trackingNumber.trim();
    const carrier = input.carrier?.trim() || null;
    if (!productName) return new ValidationError('商品名を入力してください');
    if (!trackingNumber) return new ValidationError('追跡番号を入力してください');

    const info = db
      .prepare('INSERT INTO delivery_records (product_name, tracking_number, carrier) VALUES (?, ?, ?)')
      .run(productName, trackingNumber, carrier);
    const row = asRow<DeliveryRow>(
      db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(info.lastInsertRowid)
    );
    return toDelivery(row);
  };

  const updateStatus: DeliveryRepository['updateStatus'] = (id, status) => {
    if (!DELIVERY_STATUSES.includes(status)) return new ValidationError('不正な状態です');
    const info = db.prepare('UPDATE delivery_records SET status = ? WHERE id = ?').run(status, id);
    if (info.changes === 0) return new NotFoundError();
    const row = asRow<DeliveryRow>(db.prepare('SELECT * FROM delivery_records WHERE id = ?').get(id));
    return toDelivery(row);
  };

  const remove: DeliveryRepository['remove'] = (id) => {
    const info = db.prepare('DELETE FROM delivery_records WHERE id = ?').run(id);
    if (info.changes === 0) return new NotFoundError();
    return true;
  };

  return { findAll, create, updateStatus, remove };
}
