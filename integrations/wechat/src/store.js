import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, chmodSync } from 'node:fs'
import { dirname } from 'node:path'

export const MAX_ATTEMPTS = 5
const BACKOFF_MS = [2000, 10000, 30000, 120000, 300000]

/** Durable inbound log (ordered by seq), outbound queue (idempotent by DSH message id) and audit trail. */
export class BridgeStore {
  constructor(file, now = () => Date.now()) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(file); chmodSync(file, 0o600); this.now = now
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS inbound(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, chat_id TEXT NOT NULL,
        chat_type TEXT NOT NULL, sender_id TEXT NOT NULL, mentioned INTEGER NOT NULL, text TEXT NOT NULL, at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbound(id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS outbound_pending ON outbound(state, next_at);`)
    // A send interrupted by a crash may or may not have reached WeChat; never resend it automatically.
    this.db.prepare("UPDATE outbound SET state='unknown', error='interrupted', updated_at=? WHERE state='sending'").run(this.now())
  }
  audit(kind, detail) { this.db.prepare('INSERT INTO audit(at,kind,detail) VALUES(?,?,?)').run(this.now(), kind, JSON.stringify(detail)) }
  /** Returns 'stored' or 'duplicate'; the provider message id is the idempotency key. */
  addInbound(m) {
    const r = this.db.prepare('INSERT OR IGNORE INTO inbound(id,chat_id,chat_type,sender_id,mentioned,text,at) VALUES(?,?,?,?,?,?,?)')
      .run(m.id, m.chatId, m.chatType, m.senderId, m.mentioned ? 1 : 0, m.text, m.at)
    return r.changes ? 'stored' : 'duplicate'
  }
  inbound(after, limit) {
    return this.db.prepare('SELECT * FROM inbound WHERE seq>? ORDER BY seq LIMIT ?').all(after, limit).map(r => ({
      seq: r.seq, id: r.id, chatId: r.chat_id, chatType: r.chat_type, senderId: r.sender_id, mentioned: !!r.mentioned, text: r.text, at: r.at }))
  }
  /** Enqueues once per id; a different payload under a known id is a contract violation. */
  enqueue({ id, chatId, text }) {
    const existing = this.outbound(id)
    if (existing) return existing.chatId === chatId && existing.text === text ? existing : undefined
    const at = this.now()
    this.db.prepare("INSERT INTO outbound(id,chat_id,text,state,next_at,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)").run(id, chatId, text, at, at, at)
    return this.outbound(id)
  }
  outbound(id) {
    const r = this.db.prepare('SELECT * FROM outbound WHERE id=?').get(id)
    return r && { id: r.id, chatId: r.chat_id, text: r.text, state: r.state, attempts: r.attempts, error: r.error ?? undefined }
  }
  sent() { return this.db.prepare("SELECT id,chat_id AS chatId,text FROM outbound WHERE state='sent' ORDER BY updated_at,rowid").all() }
  /** Claims the next due message, marking it `sending` so a crash leaves it `unknown` rather than resending. */
  claim() {
    const r = this.db.prepare("SELECT id FROM outbound WHERE state='pending' AND next_at<=? ORDER BY created_at,rowid LIMIT 1").get(this.now())
    if (!r) return
    this.db.prepare("UPDATE outbound SET state='sending', attempts=attempts+1, updated_at=? WHERE id=?").run(this.now(), r.id)
    return this.outbound(r.id)
  }
  settle(id, outcome, error) {
    const row = this.outbound(id), at = this.now()
    if (outcome === 'retry' && row.attempts < MAX_ATTEMPTS)
      this.db.prepare("UPDATE outbound SET state='pending', next_at=?, error=?, updated_at=? WHERE id=?").run(at + BACKOFF_MS[row.attempts - 1], error, at, id)
    else this.db.prepare('UPDATE outbound SET state=?, error=?, updated_at=? WHERE id=?').run(outcome === 'retry' ? 'failed' : outcome, error ?? null, at, id)
  }
  counts() { return Object.fromEntries(this.db.prepare('SELECT state, count(*) AS n FROM outbound GROUP BY state').all().map(r => [r.state, Number(r.n)])) }
  /** The last authorization snapshot DSH pushed, with the time it was received; survives restarts. */
  authz() { const r = this.db.prepare("SELECT value FROM kv WHERE key='authz'").get(); return r ? JSON.parse(r.value) : undefined }
  saveAuthz(snapshot) { this.db.prepare("INSERT INTO kv(key,value) VALUES('authz',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(snapshot)) }
  close() { this.db.close() }
}
