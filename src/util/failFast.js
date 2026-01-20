import fs from 'fs';

export function failFast() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY missing');
  }

  const dbPath = process.env.SNAPSHOT_SQLITE_PATH;
  if (!dbPath || !fs.existsSync(dbPath)) {
    throw new Error('SNAPSHOT_SQLITE_PATH missing or file not found');
  }
}
