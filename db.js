const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const db = new sqlite3.Database('./database.db');

db.serialize(async () => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT
    )
  `);

  // 🔥 USUÁRIO PADRÃO
  const email = 'admin@admin.com';
  const password = '123456';

  const hash = await bcrypt.hash(password, 10);

  db.get('SELECT * FROM users WHERE email = ?', [email], (err, user) => {
    if (!user) {
      db.run(
        'INSERT INTO users (email, password) VALUES (?, ?)',
        [email, hash],
        () => {
          console.log('👤 Usuário padrão criado: admin@admin.com / 123456');
        }
      );
    }
  });
});

module.exports = db;