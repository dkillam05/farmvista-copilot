import Database from 'better-sqlite3';

let db;

export function getDb() {
  if (!db) {
    db = new Database(process.env.SNAPSHOT_SQLITE_PATH, { readonly: true });
  }
  return db;
}
