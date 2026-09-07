import type { DatabaseSync } from 'node:sqlite';
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

// node:sqliteの.get()/.all()はRecord<string, SQLOutputValue>を返すため、
// 一度unknownを経由してテーブル固有の行型にキャストする。
function asRow<T>(value: unknown): T {
  return value as T;
}

/**
 * node:sqliteのDatabaseSyncにはbetter-sqlite3のdb.transaction()相当のヘルパーが無いため、
 * BEGIN/COMMIT/ROLLBACKを手動で発行する薄いラッパー。
 */
function runInTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function SqliteProductRepository(db: DatabaseSync): ProductRepository {
  const findAll: ProductRepository['findAll'] = (query) => {
    const q = (query ?? '').trim();
    if (!q) {
      return asRow<ProductRow[]>(db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all()).map(
        toProduct
      );
    }
    const like = `%${q}%`;
    return asRow<ProductRow[]>(
      db
        .prepare(
          `SELECT * FROM products
           WHERE name LIKE ? OR category LIKE ? OR barcode LIKE ?
           ORDER BY name COLLATE NOCASE`
        )
        .all(like, like, like)
    ).map(toProduct);
  };

  const findById: ProductRepository['findById'] = (id) => {
    const row = asRow<ProductRow | undefined>(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    return row ? toProduct(row) : new NotFoundError();
  };

  const findByBarcode: ProductRepository['findByBarcode'] = (barcode) => {
    const row = asRow<ProductRow | undefined>(
      db.prepare('SELECT * FROM products WHERE barcode = ?').get(barcode)
    );
    return row ? toProduct(row) : new NotFoundError();
  };

  const findReplenishmentNeeded: ProductRepository['findReplenishmentNeeded'] = () => {
    return asRow<ProductRow[]>(
      db
        .prepare(
          `SELECT * FROM products WHERE current_stock < target_stock
           ORDER BY (target_stock - current_stock) DESC`
        )
        .all()
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
      const row = asRow<ProductRow>(db.prepare('SELECT * FROM products WHERE id = ?').get(info.lastInsertRowid));
      return toProduct(row);
    } catch (err) {
      if (isUniqueViolation(err)) return new DuplicateBarcodeError();
      throw err;
    }
  };

  const update: ProductRepository['update'] = (id, input: UpdateProductInput) => {
    const existingRow = asRow<ProductRow | undefined>(
      db.prepare('SELECT * FROM products WHERE id = ?').get(id)
    );
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
      const row = asRow<ProductRow>(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
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
    return asRow<StockTransactionRow[]>(
      db
        .prepare(
          `SELECT * FROM stock_transactions WHERE product_id = ? ORDER BY created_at DESC, id DESC LIMIT 200`
        )
        .all(productId)
    ).map(toTransaction);
  };

  const recordTransaction: ProductRepository['recordTransaction'] = (productId, input) => {
    return runInTransaction<Result<Product, NotFoundError | ValidationError>>(db, () => {
      const row = asRow<ProductRow | undefined>(
        db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
      );
      if (!row) return new NotFoundError();

      const quantity = Math.trunc(input.quantity);
      if (!Number.isFinite(quantity) || quantity < 0) {
        return new ValidationError('数量は0以上の整数で指定してください');
      }

      const delta = computeDelta(input.type, quantity, row.current_stock);
      const resultingStock = Math.max(0, row.current_stock + delta);
      const actualDelta = resultingStock - row.current_stock;

      db.prepare(
        `UPDATE products SET current_stock = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(resultingStock, productId);
      db.prepare(
        `INSERT INTO stock_transactions (product_id, type, delta, resulting_stock, note)
         VALUES (?, ?, ?, ?, ?)`
      ).run(productId, input.type, actualDelta, resultingStock, input.note?.trim() || null);

      const updated = asRow<ProductRow>(db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
      return toProduct(updated);
    });
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
