// Tiny JSON-file database. Everything lives in memory and is flushed to disk
// (atomically) shortly after each change. Plenty for a friend group or a small
// community; swap for SQLite/Postgres if this ever gets popular.
import fs from 'node:fs';
import path from 'node:path';

const EMPTY = () => ({ seq: 0, users: [], ledger: [], sessions: {}, decree: null });
const MAX_LEDGER = 50000;

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'db.json');
    fs.mkdirSync(dir, { recursive: true });
    this.data = EMPTY();
    if (fs.existsSync(this.file)) {
      this.data = { ...EMPTY(), ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    }
    this.timer = null;
  }

  nextId() {
    this.data.seq += 1;
    return this.data.seq;
  }

  save() {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), 50);
  }

  flush() {
    clearTimeout(this.timer);
    this.timer = null;
    if (this.data.ledger.length > MAX_LEDGER) {
      this.data.ledger = this.data.ledger.slice(-MAX_LEDGER);
    }
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  // --- users
  get users() { return this.data.users; }
  userById(id) { return this.data.users.find((u) => u.id === id) || null; }
  userByName(username) {
    const n = String(username || '').toLowerCase();
    return this.data.users.find((u) => u.username === n) || null;
  }

  // --- ledger: every score change (and a few zero-delta events) in order
  addEntry(entry) {
    const e = { id: this.nextId(), at: Date.now(), ...entry };
    this.data.ledger.push(e);
    return e;
  }
  get ledger() { return this.data.ledger; }
}
