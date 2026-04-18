const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');

const db = new Database('./database.db');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT
  )
`);

const email = 'admin@admin.com';
const password = '123456';

const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);

if (!user) {
  const hash = bcrypt.hashSync(password, 10);

  db.prepare(
    'INSERT INTO users (email, password) VALUES (?, ?)'
  ).run(email, hash);

  console.log('👤 Usuário padrão criado: admin@admin.com / 123456');
}

module.exports = {
  run(sql, params = [], callback) {
    try {
      const stmt = db.prepare(sql);
      const result = stmt.run(...params);

      if (callback) {
        callback.call({ lastID: result.lastInsertRowid, changes: result.changes }, null);
      }

      return result;
    } catch (err) {
      if (callback) {
        callback(err);
        return;
      }
      throw err;
    }
  },

  get(sql, params = [], callback) {
    try {
      const stmt = db.prepare(sql);
      const row = stmt.get(...params);

      if (callback) {
        callback(null, row);
        return;
      }

      return row;
    } catch (err) {
      if (callback) {
        callback(err);
        return;
      }
      throw err;
    }
  },

  all(sql, params = [], callback) {
    try {
      const stmt = db.prepare(sql);
      const rows = stmt.all(...params);

      if (callback) {
        callback(null, rows);
        return;
      }

      return rows;
    } catch (err) {
      if (callback) {
        callback(err);
        return;
      }
      throw err;
    }
  },

  exec(sql) {
    return db.exec(sql);
  },

  prepare(sql) {
    return db.prepare(sql);
  }
};