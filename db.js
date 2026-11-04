'use strict';
// Base de dados SQLite (módulo embutido do Node 22) + esquema + dados iniciais.
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const { hashPassword } = require('./auth');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'biblioteca.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nome TEXT NOT NULL,
  nome_norm TEXT NOT NULL UNIQUE,
  cargo TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','superadmin')),
  ativo INTEGER NOT NULL DEFAULT 1,
  perms TEXT NOT NULL DEFAULT '[]',
  pass_hash TEXT NOT NULL,
  must_change INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  criado_em TEXT NOT NULL DEFAULT (datetime('now')),
  ultimo_acesso TEXT
);
CREATE TABLE IF NOT EXISTS books (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author TEXT NOT NULL DEFAULT '',
  isbn TEXT NOT NULL DEFAULT '',
  publisher TEXT NOT NULL DEFAULT '',
  year INTEGER,
  category TEXT NOT NULL DEFAULT 'Geral',
  total INTEGER NOT NULL DEFAULT 1 CHECK (total >= 0),
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL DEFAULT 'Membro',
  status TEXT NOT NULL DEFAULT 'Ativo',
  joined TEXT NOT NULL DEFAULT (date('now'))
);
CREATE TABLE IF NOT EXISTS loans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  out TEXT NOT NULL,
  due TEXT NOT NULL,
  returned TEXT
);
CREATE INDEX IF NOT EXISTS idx_loans_book ON loans(book_id, returned);
CREATE INDEX IF NOT EXISTS idx_loans_member ON loans(member_id, returned);
CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Aguardando'
);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  icon TEXT NOT NULL DEFAULT '•',
  text TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

const MODS = ['books', 'members', 'loans', 'reservations', 'reports'];
const ALL_PERMS = MODS.flatMap((m) => [`${m}.view`, `${m}.edit`]);

function ago(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
const norm = (t) =>
  String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();

function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function seed() {
  // Utilizadores iniciais: só se a tabela estiver vazia.
  if (db.prepare('SELECT COUNT(*) c FROM users').get().c === 0) {
    const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
    const ins = db.prepare(
      'INSERT INTO users (nome,nome_norm,cargo,role,perms,pass_hash,must_change) VALUES (?,?,?,?,?,?,?)'
    );
    ins.run('Administrador', norm('Administrador'), 'Super admin', 'superadmin', JSON.stringify(ALL_PERMS), hashPassword(adminPass), 1);
    ins.run('Ana Martins', norm('Ana Martins'), 'Bibliotecária', 'user', JSON.stringify(ALL_PERMS), hashPassword('biblioteca123'), 0);
  }
  // Dados de demonstração: só se não houver livros nem membros e SEED_DEMO != 0.
  if (process.env.SEED_DEMO !== '0' &&
      db.prepare('SELECT COUNT(*) c FROM books').get().c === 0 &&
      db.prepare('SELECT COUNT(*) c FROM members').get().c === 0) {
    tx(() => {
      const b = db.prepare('INSERT INTO books (title,author,isbn,publisher,year,category,total,location) VALUES (?,?,?,?,?,?,?,?)');
      [
        ['O Pequeno Príncipe', 'Antoine de Saint-Exupéry', '978-85-359-0277-5', 'Agir', 2015, 'Literatura', 5, 'A-01'],
        ['Sapiens: Uma Breve História da Humanidade', 'Yuval Noah Harari', '978-85-8057-080-8', 'L&PM', 2020, 'História', 4, 'B-03'],
        ['Dom Casmurro', 'Machado de Assis', '978-85-7232-999-1', 'Principis', 2019, 'Literatura', 6, 'A-04'],
        ['O Poder do Hábito', 'Charles Duhigg', '978-85-8057-344-2', 'Objetiva', 2012, 'Desenvolvimento pessoal', 3, 'C-02'],
        ['Quarto de Despejo', 'Carolina Maria de Jesus', '978-85-359-0277-6', 'Ática', 2014, 'Biografia', 3, 'A-06'],
      ].forEach((r) => b.run(...r));
      const m = db.prepare('INSERT INTO members (name,email,phone,type,status,joined) VALUES (?,?,?,?,?,?)');
      [
        ['Mariana Costa', 'mariana@email.com', '(11) 98877-6655', 'Membro', 'Ativo'],
        ['Pedro Almeida', 'pedro@email.com', '(11) 97766-5544', 'Membro', 'Ativo'],
        ['Julia Santos', 'julia@email.com', '(11) 96655-4433', 'Membro', 'Ativo'],
        ['Lucas Ferreira', 'lucas@email.com', '(11) 95544-3322', 'Membro', 'Ativo'],
        ['Rafael Oliveira', 'rafael@email.com', '(11) 94433-2211', 'Bibliotecário', 'Ativo'],
      ].forEach((r) => m.run(...r, ago(30)));
      const l = db.prepare('INSERT INTO loans (book_id,member_id,out,due,returned) VALUES (?,?,?,?,?)');
      l.run(1, 1, ago(7), ago(-7), null);
      l.run(2, 2, ago(18), ago(3), null);
      l.run(3, 3, ago(2), ago(-12), null);
      l.run(4, 4, ago(15), ago(1), null);
      l.run(5, 1, ago(29), ago(15), ago(14));
      db.prepare('INSERT INTO reservations (book_id,member_id,date,status) VALUES (?,?,?,?)').run(2, 3, ago(1), 'Aguardando');
    });
  }
}
seed();

module.exports = { db, tx, ago, norm, MODS, ALL_PERMS };
