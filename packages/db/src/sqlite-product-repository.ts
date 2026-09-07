import type { DatabaseSync } from 'node:sqlite';
import {
  computeDelta,
  DuplicateBarcodeError,
  NotFoundError,
  ValidationError,
  type BarcodeMatch,
  type NewBarcodeInput,
  type NewProductInput,
  type Product,
  type ProductBarcode,
  type ProductRepository,
  type Result,
  type StockChangeInput,
  type StockTransaction,
  type UpdateProductInput,
} from '@tikuwa/core';

interface ProductRow {
  id: number;
  name: string;
  category: string | null;
  unit: string;
  current_stock: number;
  target_stock: number;
  memo: string | null;
  created_at: string;
  updated_at: string;
}

interface ProductBarcodeRow {
  id: number;
  product_id: number;
  barcode: string;
  quantity_per_scan: number;
  label: string | null;
  created_at: string;
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

function toProduct(row: ProductRow, barcodes: ProductBarcodeRow[]): Product {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    unit: row.unit,
    currentStock: row.current_stock,
    targetStock: row.target_stock,
    memo: row.memo,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    barcodes: barcodes.map(toBarcode),
  };
}

function toBarcode(row: ProductBarcodeRow): ProductBarcode {
  return {
    id: row.id,
    productId: row.product_id,
    barcode: row.barcode,
    quantityPerScan: row.quantity_per_scan,
    label: row.label,
    createdAt: row.created_at,
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

function normalizeQuantityPerScan(value: number | undefined): number {
  return Number.isFinite(value) && value! > 0 ? Math.trunc(value!) : 1;
}

export function SqliteProductRepository(db: DatabaseSync): ProductRepository {
  const getBarcodesForProduct = (productId: number): ProductBarcodeRow[] =>
    asRow<ProductBarcodeRow[]>(
      db.prepare('SELECT * FROM product_barcodes WHERE product_id = ? ORDER BY id').all(productId)
    );

  const allBarcodesGrouped = (): Map<number, ProductBarcodeRow[]> => {
    const rows = asRow<ProductBarcodeRow[]>(
      db.prepare('SELECT * FROM product_barcodes ORDER BY product_id, id').all()
    );
    const map = new Map<number, ProductBarcodeRow[]>();
    for (const row of rows) {
      const list = map.get(row.product_id) ?? [];
      list.push(row);
      map.set(row.product_id, list);
    }
    return map;
  };

  const findAll: ProductRepository['findAll'] = (query) => {
    const q = (query ?? '').trim();
    let rows: ProductRow[];
    if (!q) {
      rows = asRow<ProductRow[]>(db.prepare('SELECT * FROM products ORDER BY name COLLATE NOCASE').all());
    } else {
      const like = `%${q}%`;
      rows = asRow<ProductRow[]>(
        db
          .prepare(
            `SELECT DISTINCT p.* FROM products p
             LEFT JOIN product_barcodes b ON b.product_id = p.id
             WHERE p.name LIKE ? OR p.category LIKE ? OR b.barcode LIKE ?
             ORDER BY p.name COLLATE NOCASE`
          )
          .all(like, like, like)
      );
    }
    const grouped = allBarcodesGrouped();
    return rows.map((r) => toProduct(r, grouped.get(r.id) ?? []));
  };

  const findById: ProductRepository['findById'] = (id) => {
    const row = asRow<ProductRow | undefined>(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    return row ? toProduct(row, getBarcodesForProduct(id)) : new NotFoundError();
  };

  const findByBarcode: ProductRepository['findByBarcode'] = (barcode) => {
    const bcRow = asRow<ProductBarcodeRow | undefined>(
      db.prepare('SELECT * FROM product_barcodes WHERE barcode = ?').get(barcode)
    );
    if (!bcRow) return new NotFoundError();
    const productRow = asRow<ProductRow | undefined>(
      db.prepare('SELECT * FROM products WHERE id = ?').get(bcRow.product_id)
    );
    if (!productRow) return new NotFoundError();
    const match: BarcodeMatch = {
      product: toProduct(productRow, getBarcodesForProduct(bcRow.product_id)),
      matchedBarcode: toBarcode(bcRow),
    };
    return match;
  };

  const findReplenishmentNeeded: ProductRepository['findReplenishmentNeeded'] = () => {
    const rows = asRow<ProductRow[]>(
      db
        .prepare(
          `SELECT * FROM products WHERE current_stock < target_stock
           ORDER BY (target_stock - current_stock) DESC`
        )
        .all()
    );
    const grouped = allBarcodesGrouped();
    return rows.map((r) => toProduct(r, grouped.get(r.id) ?? []));
  };

  const create: ProductRepository['create'] = (input: NewProductInput) => {
    const name = input.name.trim();
    if (!name) return new ValidationError('商品名は必須です');

    const targetStock = Number.isFinite(input.targetStock) ? Math.max(0, Math.trunc(input.targetStock!)) : 0;
    const currentStock = Number.isFinite(input.currentStock)
      ? Math.max(0, Math.trunc(input.currentStock!))
      : 0;

    try {
      return runInTransaction<Product>(db, () => {
        const info = db
          .prepare(
            `INSERT INTO products (name, category, unit, target_stock, current_stock, memo)
             VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(
            name,
            input.category?.trim() || null,
            input.unit?.trim() || '個',
            targetStock,
            currentStock,
            input.memo?.trim() || null
          );
        const productId = Number(info.lastInsertRowid);

        for (const bc of input.barcodes ?? []) {
          const barcode = bc.barcode.trim();
          if (!barcode) continue;
          db.prepare(
            `INSERT INTO product_barcodes (product_id, barcode, quantity_per_scan, label)
             VALUES (?, ?, ?, ?)`
          ).run(productId, barcode, normalizeQuantityPerScan(bc.quantityPerScan), bc.label?.trim() || null);
        }

        const row = asRow<ProductRow>(db.prepare('SELECT * FROM products WHERE id = ?').get(productId));
        return toProduct(row, getBarcodesForProduct(productId));
      });
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
    const category = input.category !== undefined ? input.category?.trim() || null : existingRow.category;
    const unit = input.unit !== undefined && input.unit.trim() ? input.unit.trim() : existingRow.unit;
    const targetStock =
      input.targetStock !== undefined && Number.isFinite(input.targetStock)
        ? Math.max(0, Math.trunc(input.targetStock))
        : existingRow.target_stock;
    const memo = input.memo !== undefined ? input.memo?.trim() || null : existingRow.memo;

    db.prepare(
      `UPDATE products SET
        name = ?, category = ?, unit = ?, target_stock = ?, memo = ?,
        updated_at = datetime('now','localtime')
       WHERE id = ?`
    ).run(name, category, unit, targetStock, memo, id);
    const row = asRow<ProductRow>(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    return toProduct(row, getBarcodesForProduct(id));
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
      return toProduct(updated, getBarcodesForProduct(productId));
    });
  };

  const addBarcode: ProductRepository['addBarcode'] = (productId, input: NewBarcodeInput) => {
    const barcode = input.barcode.trim();
    if (!barcode) return new ValidationError('バーコードを入力してください');

    const product = asRow<ProductRow | undefined>(
      db.prepare('SELECT * FROM products WHERE id = ?').get(productId)
    );
    if (!product) return new NotFoundError();

    try {
      const info = db
        .prepare(
          `INSERT INTO product_barcodes (product_id, barcode, quantity_per_scan, label)
           VALUES (?, ?, ?, ?)`
        )
        .run(productId, barcode, normalizeQuantityPerScan(input.quantityPerScan), input.label?.trim() || null);
      const row = asRow<ProductBarcodeRow>(
        db.prepare('SELECT * FROM product_barcodes WHERE id = ?').get(info.lastInsertRowid)
      );
      return toBarcode(row);
    } catch (err) {
      if (isUniqueViolation(err)) return new DuplicateBarcodeError();
      throw err;
    }
  };

  const removeBarcode: ProductRepository['removeBarcode'] = (barcodeId) => {
    const info = db.prepare('DELETE FROM product_barcodes WHERE id = ?').run(barcodeId);
    if (info.changes === 0) return new NotFoundError();
    return true;
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
    addBarcode,
    removeBarcode,
  };
}
