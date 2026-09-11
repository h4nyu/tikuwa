import type { DatabaseSync } from 'node:sqlite';

export function migrate(db: DatabaseSync): void {
  db.exec('PRAGMA journal_mode = WAL');

  const productsTableExists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='products'")
    .get();

  if (productsTableExists) {
    const columns = db.prepare('PRAGMA table_info(products)').all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'barcode')) {
      migrateAwayFromLegacyBarcodeColumn(db);
    }
  }

  db.exec('PRAGMA foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT,
      unit TEXT NOT NULL DEFAULT '個',
      current_stock INTEGER NOT NULL DEFAULT 0,
      target_stock INTEGER NOT NULL DEFAULT 0,
      memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS product_barcodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      barcode TEXT NOT NULL UNIQUE,
      quantity_per_scan INTEGER NOT NULL DEFAULT 1,
      label TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_product_barcodes_product ON product_barcodes(product_id);

    CREATE TABLE IF NOT EXISTS stock_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('in','out','adjust')),
      delta INTEGER NOT NULL,
      resulting_stock INTEGER NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_transactions_product ON stock_transactions(product_id, created_at);

    CREATE TABLE IF NOT EXISTS delivery_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      product_name TEXT NOT NULL,
      tracking_number TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT '発注済み',
      carrier TEXT,
      category TEXT,
      international_tracking_number TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
  `);

  migrateDeliveryColumns(db);
}

/**
 * 既存のdelivery_recordsテーブルに新しい列が無ければ追加する
 * (状態ボタン・運送会社・カテゴリ・国際追跡番号の追加分)。
 */
function migrateDeliveryColumns(db: DatabaseSync): void {
  const deliveryTableExists = !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='delivery_records'")
    .get();
  if (!deliveryTableExists) return;

  const columns = db.prepare('PRAGMA table_info(delivery_records)').all() as Array<{ name: string }>;
  if (!columns.some((c) => c.name === 'status')) {
    db.exec(`ALTER TABLE delivery_records ADD COLUMN status TEXT NOT NULL DEFAULT '発注済み'`);
  }
  if (!columns.some((c) => c.name === 'carrier')) {
    db.exec('ALTER TABLE delivery_records ADD COLUMN carrier TEXT');
  }
  if (!columns.some((c) => c.name === 'category')) {
    db.exec('ALTER TABLE delivery_records ADD COLUMN category TEXT');
  }
  if (!columns.some((c) => c.name === 'international_tracking_number')) {
    db.exec('ALTER TABLE delivery_records ADD COLUMN international_tracking_number TEXT');
  }
}

/**
 * 旧スキーマ(products.barcode列に単一バーコードを直接持たせていた版)から
 * product_barcodesテーブルへの一回限りの移行。
 *
 * SQLiteはUNIQUE制約付き列をDROP COLUMNできないため、テーブルを作り直す。
 * また通常のRENAME TOは他テーブルの外部キー参照テキストを自動書き換えてしまう
 * (stock_transactionsのREFERENCES productsが追従してしまう)ため、
 * legacy_alter_table を一時的に有効化してその挙動を止める。
 */
function migrateAwayFromLegacyBarcodeColumn(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec('BEGIN');
  try {
    db.exec('PRAGMA legacy_alter_table = ON');
    db.exec('ALTER TABLE products RENAME TO products_old_barcode_migration');
    db.exec('PRAGMA legacy_alter_table = OFF');

    db.exec(`
      CREATE TABLE products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        category TEXT,
        unit TEXT NOT NULL DEFAULT '個',
        current_stock INTEGER NOT NULL DEFAULT 0,
        target_stock INTEGER NOT NULL DEFAULT 0,
        memo TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `);
    db.exec(`
      INSERT INTO products (id, name, category, unit, current_stock, target_stock, memo, created_at, updated_at)
      SELECT id, name, category, unit, current_stock, target_stock, memo, created_at, updated_at
      FROM products_old_barcode_migration;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS product_barcodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
        barcode TEXT NOT NULL UNIQUE,
        quantity_per_scan INTEGER NOT NULL DEFAULT 1,
        label TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
    `);
    db.exec(`
      INSERT OR IGNORE INTO product_barcodes (product_id, barcode, quantity_per_scan)
      SELECT id, barcode, 1 FROM products_old_barcode_migration WHERE barcode IS NOT NULL;
    `);

    db.exec('DROP TABLE products_old_barcode_migration');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}
