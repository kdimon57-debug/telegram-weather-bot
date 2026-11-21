import { DatabaseSync } from 'node:sqlite'

export function openStore(path) {
  const db = new DatabaseSync(path)
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS chats (
      chat_id INTEGER PRIMARY KEY,
      settings TEXT NOT NULL,
      active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      chat_id INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      PRIMARY KEY (chat_id, local_date)
    );
  `)
  const load = db.prepare('SELECT settings FROM chats WHERE chat_id = ?')
  const save = db.prepare(`
    INSERT INTO chats (chat_id, settings, active) VALUES (?, ?, ?)
    ON CONFLICT (chat_id) DO UPDATE SET settings = excluded.settings, active = excluded.active
  `)
  const active = db.prepare('SELECT chat_id, settings FROM chats WHERE active = 1')
  const delivered = db.prepare('SELECT 1 FROM deliveries WHERE chat_id = ? AND local_date = ?')
  const record = db.prepare('INSERT OR IGNORE INTO deliveries VALUES (?, ?)')
  const prune = db.prepare('DELETE FROM deliveries WHERE local_date < ?')

  return {
    get(chatId) {
      const row = load.get(chatId)
      return row ? JSON.parse(row.settings) : {}
    },
    save(chatId, settings) {
      save.run(chatId, JSON.stringify(settings), Number(Boolean(settings.schedule && !settings.paused)))
    },
    active() {
      return active.all().map(row => [row.chat_id, JSON.parse(row.settings).schedule])
    },
    delivered: (chatId, date) => Boolean(delivered.get(chatId, date)),
    record: (chatId, date) => record.run(chatId, date),
    prune: date => prune.run(date),
    close: () => db.close()
  }
}
