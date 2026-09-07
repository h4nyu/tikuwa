import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { migrate } from './schema';

export function openDatabase(filePath: string): Database.Database {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new Database(filePath);
  migrate(db);
  return db;
}
