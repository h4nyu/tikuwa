import type Database from 'better-sqlite3';
import {
  computeDelta,
  DuplicateBarcodeError,
  NotFoundError,
  ValidationError,
  type NewProductInput,
  type Product,
  type ProductRepository,
  type Result,
  type StockChangeInput,
  type StockTransaction,
  type UpdateProductInput,
} from '@tikuwa/core';

interface ProductRow {
  id: number;
  name: string;
  barcode: string | null;
  category: string | null;
  unit: string;
  current_stock: number;
  target_stock: number;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

interface StockTransactionRow {
  id: number;
  product_id: number;
  type: 'in' | 'out' | 'adjust';
  delta: number;
  resulting_stock: number;
  note: string | null;
  created_at: string;
}

function toProduct(row: ProductRow): Product {
  return {
    id: row.id,
    name: row.name,
    barcode: row.barcode,
    category: row.category,
    unit: row.unit,
    currentStock: row.current_stock,
    targetStock: row.target_stock,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toTransaction(row: StockTransactionRow): StockTransaction {
  return {
    id: row.id,
    productId: row.product_id,
    type: row.type,
    delta: row.delta,
    resultingStock: row.resulting_stock,
    note: row.note,
    createdAt: row.created_at,
  };
}

function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && err.message.includes('UNIQUE');
}

export function SqliteProductRepository(db: Database.Database): ProductRepository {
  const findAll: ProductRepository['findAll'] = (query) => {
    const q = (query ?? '').trim();
    if (!q) {
      return (db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all() as ProductRow[]).map(
        toProduct
      );
    }
    const like = `%${q}%`;
    return (
      db
        .prepare(
          `SELECT * FROM products
           WHERE name LIKE ? OR category LIKE ? OR barcode LIKE ?
           ORDER BY name COLLATE NOCASE`
        )
        .all(like, like, like) as ProductRow[]
    ).map(toProduct);
  };

  const findById: ProductRepository['findById'] = (id) => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined;
    return row ? toProduct(row) : new NotFoundError();
  };

  const findByBarcode: ProductRepository['findByBarcode'] = (barcode) => {
    const row = db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode) as
      | ProductRow
      | undefined;
    return row ? toProduct(row) : new NotFoundError();
  };

  const findReplenishmentNeeded: ProductRepository['findReplenishmentNeeded'] = () => {
    return (
      db
        .prepare(
          `SELECT * FROM products WHERE current_stock < target_stock
           ORDER BY (target_stock - current_stock) DESC`
        )
        .all() as ProductRow[]
    ).map(toProduct);
  };

  const create: ProductRepository['create'] = (input: NewProductInput) => {
    const name = input.name.trim();
    if (!name) return new ValidationError('商品名は必須です');

    const targetStock = Number.isFinite(input.targetStock) ? Math.max(0, Math.trunc(input.targetStock!)) : 0;
    const currentStock = Number.isFinite(input.currentStock)
      ? Math.max(0, Math.trunc(input.currentStock!))
      : 0;

    try {
      const info = db
        .prepare(
          `INSERT INTO products (name, barcode, category, unit, target_stock, current_stock, memo)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          name,
          input.barcode?.trim() || null,
          input.category?.trim() || null,
          input.unit?.trim() || '個',
          targetStock,
          currentStock,
          input.memo?.trim() || null
        );
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid) as ProductRow;
      return toProduct(row);
    } catch (err) {
      if (isUniqueViolation(err)) return new DuplicateBarcodeError();
      throw err;
    }
  };

  const update: ProductRepository['update'] = (id, input: UpdateProductInput) => {
    const existingRow = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as
      | ProductRow
      | undefined;
    if (!existingRow) return new NotFoundError();

    const name = input.name !== undefined && input.name.trim() ? input.name.trim() : existingRow.name;
    const barcode = input.barcode !== undefined ? input.barcode?.trim() || null : existingRow.barcode;
    const category = input.category !== undefined ? input.category?.trim() || null : existingRow.category;
    const unit = input.unit !== undefined && input.unit.trim() ? input.unit.trim() : existingRow.unit;
    const targetStock =
      input.targetStock !== undefined && Number.isFinite(input.targetStock)
        ? Math.max(0, Math.trunc(input.targetStock))
        : existingRow.target_stock;
    const memo = input.memo !== undefined ? input.memo?.trim() || null : existingRow.memo;

    try {
      db.prepare(
        `UPDATE products SET
          name = ?, barcode = ?, category = ?, unit = ?, target_stock = ?, memo = ?,
          updated_at = datetime('now','localtime')
         WHERE id = ?`
      ).run(name, barcode, category, unit, targetStock, memo, id);
      const row = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow;
      return toProduct(row);
    } catch (err) {
      if (isUniqueViolation(err)) return new DuplicateBarcodeError();
      throw err;
    }
  };

  const remove: ProductRepository['remove'] = (id) => {
    const info = db.prepare('DELETE FROM products WHERE id = ?').run(id);
    if (info.changes === 0) return new NotFoundError();
    return true;
  };

  const listTransactions: ProductRepository['listTransactions'] = (productId) => {
    return (
      db
        .prepare(
          `SELECT * FROM stock_transactions WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
        )
        .all(productId) as StockTransactionRow[]
    ).map(toTransaction);
  };

  const applyTransaction = db.transaction((productId: number, input: StockChangeInput): Result<
    Product,
    NotFoundError | ValidationError
  > => {
    const row = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as
      | ProductRow
      | undefined;
    if (!row) return new NotFoundError();

    const quantity = Math.trunc(input.quantity);
    if (!Number.isFinite(quantity) || quantity < 0) {
      return new ValidationError('数量は0以上の整数で指定してください');
    }

    const delta = computeDelta(input.type, quantity, row.current_stock);
    const resultingStock = Math.max(0, row.current_stock + delta);
    const actualDelta = resultingStock - row.current_stock;

    db.prepare(`UPDATE products SET current_stock = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(
      resultingStock,
      productId
    );
    db.prepare(
      `INSERT INTO stock_transactions (product_id, type, delta, resulting_stock, note)
       VALUES (?, ?, ?, ?, ?)`
    ).run(productId, input.type, actualDelta, resultingStock, input.note?.trim() || null);

    const updated = db.prepare('SELECT * FROM products WHERE id = ?').get(productId) as ProductRow;
    return toProduct(updated);
  });

  const recordTransaction: ProductRepository['recordTransaction'] = (productId, input) => {
    return applyTransaction(productId, input);
  };

  return {
    findAll,
    findById,
    findByBarcode,
    findReplenishmentNeeded,
    create,
    update,
    remove,
    listTransactions,
    recordTransaction,
  };
}
