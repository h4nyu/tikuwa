import type { DatabaseSync } from 'node:sqlite';
import {
  NotFoundError,
  ValidationError,
  SALE_PLATFORMS,
  type SaleRepository,
  type SaleRecord,
  type SalePlatform,
  type NewSaleRecordInput,
  type UpdateSaleRecordInput,
} from '@tikuwa/core';

interface SaleRow {
  id: number;
  platform: string;
  product_name: string;
  sale_date: string;
  sale_amount: number;
  fee: number;
  shipping_cost: number;
  memo: string | null;
  created_at: string;
}

function toSale(row: SaleRow): SaleRecord {
  return {
    id: row.id,
    platform: row.platform as SalePlatform,
    productName: row.product_name,
    saleDate: row.sale_date,
    saleAmount: row.sale_amount,
    fee: row.fee,
    shippingCost: row.shipping_cost,
    memo: row.memo,
    createdAt: row.created_at,
  };
}

function asRow<T>(value: unknown): T {
  return value as T;
}

export function SqliteSaleRepository(db: DatabaseSync): SaleRepository {
  const findAll: SaleRepository['findAll'] = () => {
    return asRow<SaleRow[]>(db.prepare('SELECT * FROM sale_records ORDER BY sale_date DESC, id DESC').all()).map(
      toSale
    );
  };

  const create: SaleRepository['create'] = (input: NewSaleRecordInput) => {
    const platform = input.platform;
    const productName = input.productName.trim();
    const saleDate = input.saleDate.trim();
    const saleAmount = Math.trunc(input.saleAmount);
    const fee = Math.trunc(input.fee ?? 0);
    const shippingCost = Math.trunc(input.shippingCost ?? 0);
    const memo = input.memo?.trim() || null;
    if (!SALE_PLATFORMS.includes(platform)) return new ValidationError('不正なプラットフォームです');
    if (!productName) return new ValidationError('商品名を入力してください');
    if (!saleDate) return new ValidationError('売却日を入力してください');
    if (!Number.isFinite(saleAmount) || saleAmount < 0) return new ValidationError('販売価格を正しく入力してください');

    const info = db
      .prepare(
        `INSERT INTO sale_records (platform, product_name, sale_date, sale_amount, fee, shipping_cost, memo)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(platform, productName, saleDate, saleAmount, fee, shippingCost, memo);
    const row = asRow<SaleRow>(db.prepare('SELECT * FROM sale_records WHERE id = ?').get(info.lastInsertRowid));
    return toSale(row);
  };

  const update: SaleRepository['update'] = (id, input: UpdateSaleRecordInput) => {
    const existingRow = asRow<SaleRow | undefined>(db.prepare('SELECT * FROM sale_records WHERE id = ?').get(id));
    if (!existingRow) return new NotFoundError();

    if (input.platform !== undefined && !SALE_PLATFORMS.includes(input.platform)) {
      return new ValidationError('不正なプラットフォームです');
    }
    const platform = input.platform ?? (existingRow.platform as SalePlatform);
    const productName =
      input.productName !== undefined && input.productName.trim() ? input.productName.trim() : existingRow.product_name;
    const saleDate = input.saleDate !== undefined && input.saleDate.trim() ? input.saleDate.trim() : existingRow.sale_date;
    const saleAmount = input.saleAmount !== undefined ? Math.trunc(input.saleAmount) : existingRow.sale_amount;
    const fee = input.fee !== undefined ? Math.trunc(input.fee) : existingRow.fee;
    const shippingCost = input.shippingCost !== undefined ? Math.trunc(input.shippingCost) : existingRow.shipping_cost;
    const memo = input.memo !== undefined ? input.memo?.trim() || null : existingRow.memo;
    if (!productName) return new ValidationError('商品名を入力してください');
    if (!saleDate) return new ValidationError('売却日を入力してください');
    if (!Number.isFinite(saleAmount) || saleAmount < 0) return new ValidationError('販売価格を正しく入力してください');

    db.prepare(
      `UPDATE sale_records SET
        platform = ?, product_name = ?, sale_date = ?, sale_amount = ?, fee = ?, shipping_cost = ?, memo = ?
       WHERE id = ?`
    ).run(platform, productName, saleDate, saleAmount, fee, shippingCost, memo, id);
    const row = asRow<SaleRow>(db.prepare('SELECT * FROM sale_records WHERE id = ?').get(id));
    return toSale(row);
  };

  const remove: SaleRepository['remove'] = (id) => {
    const info = db.prepare('DELETE FROM sale_records WHERE id = ?').run(id);
    if (info.changes === 0) return new NotFoundError();
    return true;
  };

  return { findAll, create, update, remove };
}
