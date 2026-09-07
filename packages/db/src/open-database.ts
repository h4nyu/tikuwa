import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './schema';

export function openDatabase(filePath: string): DatabaseSync {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const db = new DatabaseSync(filePath);
  migrate(db);
  return db;
}
