'use strict';
// Biblioteca Viva — servidor HTTP (API REST + ficheiros estáticos). Sem dependências externas.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { db, tx, ago, norm, MODS, ALL_PERMS } = require('./db');
const { hashPassword, verifyPassword, signToken, verifyToken } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1 MB
const LOAN_LIMIT = 5;
const FINE_PER_DAY = 2;

/* ---------- utilitários ---------- */
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (m) => new HttpError(400, m);
const forbidden = (m = 'Você não tem permissão para esta ação.') => new HttpError(403, m);
const notFound = (m = 'Registo não encontrado.') => new HttpError(404, m);
const conflict = (m) => new HttpError(409, m);

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T12:00:00'));
const str = (v, { max = 300, required = false, name = 'campo' } = {}) => {
  const s = String(v ?? '').trim();
  if (required && !s) throw bad(`Preencha o campo: ${name}.`);
  if (s.length > max) throw bad(`O campo ${name} é demasiado longo (máx. ${max}).`);
  return s;
};
const int = (v, { min = 0, max = 1e9, name = 'número' } = {}) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`Valor inválido para ${name}.`);
  return n;
};
const log = (icon, text) => {
  db.prepare('INSERT INTO activity (icon,text) VALUES (?,?)').run(icon, text);
  db.prepare('DELETE FROM activity WHERE id <= (SELECT MAX(id) FROM activity) - 200').run();
};

const userRow = (u) => ({
  id: u.id,
  nome: u.nome,
  cargo: u.cargo,
  role: u.role,
  ativo: !!u.ativo,
  perms: JSON.parse(u.perms),
  mustChange: !!u.must_change,
  criadoEm: u.criado_em,
  ultimoAcesso: u.ultimo_acesso,
});
const can = (u, mod, act) => {
  if (u.role === 'superadmin') return true;
  const p = JSON.parse(u.perms);
  return act === 'view' ? p.includes(`${mod}.view`) : p.includes(`${mod}.view`) && p.includes(`${mod}.edit`);
};
const need = (u, mod, act = 'edit') => {
  if (!can(u, mod, act)) throw forbidden();
};
const needSA = (u) => {
  if (u.role !== 'superadmin') throw forbidden('Apenas o super admin pode fazer isto.');
};
const activeSAs = () => db.prepare("SELECT COUNT(*) c FROM users WHERE role='superadmin' AND ativo=1").get().c;

function cleanPerms(list) {
  const set = new Set((Array.isArray(list) ? list : []).filter((p) => ALL_PERMS.includes(p)));
  for (const m of MODS) if (set.has(`${m}.edit`)) set.add(`${m}.view`);
  return ALL_PERMS.filter((p) => set.has(p));
}
const validPassword = (p) => {
  if (typeof p !== 'string' || p.length < 6) throw bad('A senha deve ter pelo menos 6 caracteres.');
  if (p.length > 200) throw bad('Senha demasiado longa.');
  return p;
};

/* ---------- livros / empréstimos (regras) ---------- */
const activeLoansOf = (bookId) => db.prepare('SELECT COUNT(*) c FROM loans WHERE book_id=? AND returned IS NULL').get(bookId).c;
const bookOut = (b) => ({ id: b.id, title: b.title, author: b.author, isbn: b.isbn, publisher: b.publisher, year: b.year, category: b.category, total: b.total, location: b.location, description: b.description });
const loanOut = (l) => ({ id: l.id, bookId: l.book_id, memberId: l.member_id, out: l.out, due: l.due, returned: l.returned });
const resOut = (r) => ({ id: r.id, bookId: r.book_id, memberId: r.member_id, date: r.date, status: r.status });
const memberOut = (m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone, type: m.type, status: m.status, joined: m.joined });

function bookInput(b) {
  const year = b.year === '' || b.year == null ? null : int(b.year, { min: 0, max: 2200, name: 'ano' });
  return {
    title: str(b.title, { required: true, name: 'título' }),
    author: str(b.author, { name: 'autor' }),
    isbn: str(b.isbn, { max: 40, name: 'ISBN' }),
    publisher: str(b.publisher, { name: 'editora' }),
    year,
    category: str(b.category, { max: 80, name: 'categoria' }) || 'Geral',
    total: int(b.total, { min: 1, max: 100000, name: 'quantidade total' }),
    location: str(b.location, { max: 40, name: 'localização' }),
    description: str(b.description, { max: 2000, name: 'descrição' }),
  };
}
function memberInput(m) {
  const type = str(m.type, { max: 40 }) || 'Membro';
  const status = str(m.status, { max: 20 }) || 'Ativo';
  if (!['Membro', 'Bibliotecário', 'Administrador'].includes(type)) throw bad('Tipo de usuário inválido.');
  if (!['Ativo', 'Inativo'].includes(status)) throw bad('Estado inválido.');
  const email = str(m.email, { max: 200, name: 'e-mail' });
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('E-mail inválido.');
  return { name: str(m.name, { required: true, name: 'nome' }), email, phone: str(m.phone, { max: 40, name: 'telefone' }), type, status };
}

/* ---------- limitação de tentativas de login ---------- */
const attempts = new Map(); // chave -> {n, until}
function loginKey(req, nome) {
  return `${req.socket.remoteAddress}|${norm(nome)}`;
}
function checkLock(key) {
  const a = attempts.get(key);
  if (a && a.until > Date.now()) throw new HttpError(429, `Muitas tentativas. Aguarde ${Math.ceil((a.until - Date.now()) / 1000)} s.`);
}
function failLogin(key) {
  const a = attempts.get(key) || { n: 0, until: 0 };
  a.n += 1;
  if (a.n >= 5) {
    a.n = 0;
    a.until = Date.now() + 30000;
  }
  attempts.set(key, a);
  if (attempts.size > 5000) attempts.clear();
}
const DUMMY_HASH = hashPassword('dummy-password-for-timing');

/* ---------- rotas ---------- */
const routes = [];
const route = (method, pattern, opts, handler) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, auth: opts.auth !== false, handler });
};

route('GET', '/api/health', { auth: false }, () => ({ ok: true, time: new Date().toISOString() }));

/* Autenticação */
route('POST', '/api/auth/login', { auth: false }, ({ body, req }) => {
  const nome = str(body.nome, { required: true, name: 'nome' });
  const senha = String(body.senha ?? '');
  if (!senha) throw bad('Preencha o nome e a senha.');
  const key = loginKey(req, nome);
  checkLock(key);
  const u = db.prepare('SELECT * FROM users WHERE nome_norm=?').get(norm(nome));
  const ok = verifyPassword(senha, u ? u.pass_hash : DUMMY_HASH) && !!u;
  if (!ok) {
    failLogin(key);
    throw new HttpError(401, 'Nome ou senha incorretos.');
  }
  if (!u.ativo) throw forbidden('Esta conta está desativada. Fale com o super admin.');
  attempts.delete(key);
  db.prepare("UPDATE users SET ultimo_acesso=datetime('now') WHERE id=?").run(u.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(u.id);
  return { token: signToken(fresh), user: userRow(fresh) };
});
route('GET', '/api/auth/me', {}, ({ user }) => ({ user: userRow(user) }));
route('POST', '/api/auth/password', {}, ({ user, body }) => {
  const forced = !!user.must_change;
  if (!forced && !verifyPassword(String(body.atual ?? ''), user.pass_hash)) throw bad('Senha atual incorreta.');
  const nova = validPassword(body.nova);
  if (verifyPassword(nova, user.pass_hash)) throw bad('A nova senha deve ser diferente da atual.');
  db.prepare('UPDATE users SET pass_hash=?, must_change=0, token_version=token_version+1 WHERE id=?').run(hashPassword(nova), user.id);
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id);
  return { token: signToken(fresh), user: userRow(fresh) };
});

/* Utilizadores (super admin) */
route('GET', '/api/users', {}, ({ user }) => {
  needSA(user);
  return db.prepare('SELECT * FROM users ORDER BY nome COLLATE NOCASE').all().map(userRow);
});
route('POST', '/api/users', {}, ({ user, body }) => {
  needSA(user);
  const nome = str(body.nome, { required: true, name: 'nome' }).replace(/\s+/g, ' ');
  if (db.prepare('SELECT 1 FROM users WHERE nome_norm=?').get(norm(nome))) throw conflict('Já existe um usuário com este nome.');
  const role = body.role === 'superadmin' ? 'superadmin' : 'user';
  const perms = role === 'superadmin' ? ALL_PERMS : cleanPerms(body.perms);
  const senha = validPassword(body.senha);
  const r = db
    .prepare('INSERT INTO users (nome,nome_norm,cargo,role,ativo,perms,pass_hash,must_change) VALUES (?,?,?,?,?,?,?,?)')
    .run(nome, norm(nome), str(body.cargo, { max: 80 }), role, body.ativo === false ? 0 : 1, JSON.stringify(perms), hashPassword(senha), body.mustChange ? 1 : 0);
  return { status: 201, data: userRow(db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid)) };
});
route('PUT', '/api/users/:id', {}, ({ user, body, params }) => {
  needSA(user);
  const id = int(params.id, { min: 1 });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound('Usuário não encontrado.');
  const nome = str(body.nome, { required: true, name: 'nome' }).replace(/\s+/g, ' ');
  const dup = db.prepare('SELECT id FROM users WHERE nome_norm=?').get(norm(nome));
  if (dup && dup.id !== id) throw conflict('Já existe um usuário com este nome.');
  const role = body.role === 'superadmin' ? 'superadmin' : 'user';
  const ativo = body.ativo === false ? 0 : 1;
  const wasSA = u.role === 'superadmin' && u.ativo;
  if (wasSA && !(role === 'superadmin' && ativo) && activeSAs() <= 1) throw bad('Deve existir pelo menos um super admin ativo.');
  if (id === user.id && !ativo) throw bad('Você não pode desativar a própria conta.');
  const perms = role === 'superadmin' ? ALL_PERMS : cleanPerms(body.perms);
  db.prepare('UPDATE users SET nome=?,nome_norm=?,cargo=?,role=?,ativo=?,perms=?,token_version=token_version+? WHERE id=?').run(
    nome, norm(nome), str(body.cargo, { max: 80 }), role, ativo, JSON.stringify(perms), id === user.id ? 0 : 1, id
  );
  return userRow(db.prepare('SELECT * FROM users WHERE id=?').get(id));
});
route('POST', '/api/users/:id/password', {}, ({ user, body, params }) => {
  needSA(user);
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(id)) throw notFound('Usuário não encontrado.');
  db.prepare('UPDATE users SET pass_hash=?, must_change=?, token_version=token_version+1 WHERE id=?').run(
    hashPassword(validPassword(body.senha)), body.mustChange === false ? 0 : 1, id
  );
  return { ok: true };
});
route('POST', '/api/users/:id/toggle', {}, ({ user, params }) => {
  needSA(user);
  const id = int(params.id, { min: 1 });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound('Usuário não encontrado.');
  if (id === user.id) throw bad('Você não pode desativar a própria conta.');
  if (u.ativo && u.role === 'superadmin' && activeSAs() <= 1) throw bad('Deve existir pelo menos um super admin ativo.');
  db.prepare('UPDATE users SET ativo=?, token_version=token_version+1 WHERE id=?').run(u.ativo ? 0 : 1, id);
  return userRow(db.prepare('SELECT * FROM users WHERE id=?').get(id));
});
route('DELETE', '/api/users/:id', {}, ({ user, params }) => {
  needSA(user);
  const id = int(params.id, { min: 1 });
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) throw notFound('Usuário não encontrado.');
  if (id === user.id) throw bad('Você não pode excluir a própria conta.');
  if (u.role === 'superadmin' && u.ativo && activeSAs() <= 1) throw bad('Deve existir pelo menos um super admin ativo.');
  db.prepare('DELETE FROM users WHERE id=?').run(id);
  return { ok: true };
});

/* Snapshot de dados para a interface */
route('GET', '/api/data', {}, ({ user }) => {
  const books = db.prepare('SELECT * FROM books ORDER BY id').all().map(bookOut);
  const members = db.prepare('SELECT * FROM members ORDER BY id').all().map((m) => {
    const o = memberOut(m);
    return can(user, 'members', 'view') ? o : { id: o.id, name: o.name, type: o.type, status: o.status, email: '', phone: '', joined: o.joined };
  });
  const loans = db.prepare('SELECT * FROM loans ORDER BY id').all().map(loanOut);
  const reservations = db.prepare('SELECT * FROM reservations ORDER BY id').all().map(resOut);
  const activity = db
    .prepare('SELECT * FROM activity ORDER BY id DESC LIMIT 30')
    .all()
    .reverse()
    .map((a) => ({ icon: a.icon, text: a.text, time: a.at }));
  return { books, members, loans, reservations, activity };
});

/* Livros */
route('POST', '/api/books', {}, ({ user, body }) => {
  need(user, 'books');
  const d = bookInput(body);
  const r = db.prepare('INSERT INTO books (title,author,isbn,publisher,year,category,total,location,description) VALUES (?,?,?,?,?,?,?,?,?)').run(
    d.title, d.author, d.isbn, d.publisher, d.year, d.category, d.total, d.location, d.description
  );
  log('▤', `Livro “${d.title}” cadastrado.`);
  return { status: 201, data: bookOut(db.prepare('SELECT * FROM books WHERE id=?').get(r.lastInsertRowid)) };
});
route('PUT', '/api/books/:id', {}, ({ user, body, params }) => {
  need(user, 'books');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM books WHERE id=?').get(id)) throw notFound('Livro não encontrado.');
  const d = bookInput(body);
  if (d.total < activeLoansOf(id)) throw conflict(`Existem ${activeLoansOf(id)} exemplares emprestados; a quantidade total não pode ser menor.`);
  db.prepare('UPDATE books SET title=?,author=?,isbn=?,publisher=?,year=?,category=?,total=?,location=?,description=? WHERE id=?').run(
    d.title, d.author, d.isbn, d.publisher, d.year, d.category, d.total, d.location, d.description, id
  );
  return bookOut(db.prepare('SELECT * FROM books WHERE id=?').get(id));
});
route('DELETE', '/api/books/:id', {}, ({ user, params }) => {
  need(user, 'books');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM books WHERE id=?').get(id)) throw notFound('Livro não encontrado.');
  if (activeLoansOf(id) > 0) throw conflict('Este livro tem empréstimos ativos. Registe as devoluções antes de excluir.');
  db.prepare('DELETE FROM books WHERE id=?').run(id);
  log('−', 'Um livro foi removido do acervo.');
  return { ok: true };
});

/* Membros */
route('POST', '/api/members', {}, ({ user, body }) => {
  need(user, 'members');
  const d = memberInput(body);
  const r = db.prepare('INSERT INTO members (name,email,phone,type,status) VALUES (?,?,?,?,?)').run(d.name, d.email, d.phone, d.type, d.status);
  log('♙', `Membro ${d.name} cadastrado.`);
  return { status: 201, data: memberOut(db.prepare('SELECT * FROM members WHERE id=?').get(r.lastInsertRowid)) };
});
route('PUT', '/api/members/:id', {}, ({ user, body, params }) => {
  need(user, 'members');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM members WHERE id=?').get(id)) throw notFound('Membro não encontrado.');
  const d = memberInput(body);
  db.prepare('UPDATE members SET name=?,email=?,phone=?,type=?,status=? WHERE id=?').run(d.name, d.email, d.phone, d.type, d.status, id);
  return memberOut(db.prepare('SELECT * FROM members WHERE id=?').get(id));
});
route('DELETE', '/api/members/:id', {}, ({ user, params }) => {
  need(user, 'members');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM members WHERE id=?').get(id)) throw notFound('Membro não encontrado.');
  if (db.prepare('SELECT COUNT(*) c FROM loans WHERE member_id=? AND returned IS NULL').get(id).c > 0)
    throw conflict('Encerre os empréstimos ativos antes de excluir.');
  db.prepare('DELETE FROM members WHERE id=?').run(id);
  return { ok: true };
});

/* Empréstimos */
route('POST', '/api/loans', {}, ({ user, body }) => {
  need(user, 'loans');
  const bookId = int(body.bookId, { min: 1, name: 'livro' });
  const memberId = int(body.memberId, { min: 1, name: 'membro' });
  const out = body.out || ago(0);
  const due = body.due || ago(-14);
  if (!isDate(out) || !isDate(due)) throw bad('Datas inválidas.');
  if (due < out) throw bad('A devolução prevista não pode ser anterior à data de saída.');
  return tx(() => {
    const b = db.prepare('SELECT * FROM books WHERE id=?').get(bookId);
    const m = db.prepare('SELECT * FROM members WHERE id=?').get(memberId);
    if (!b) throw notFound('Livro não encontrado.');
    if (!m) throw notFound('Membro não encontrado.');
    if (m.status !== 'Ativo') throw conflict('O membro está inativo.');
    if (activeLoansOf(bookId) >= b.total) throw conflict('Não há exemplares disponíveis.');
    if (db.prepare('SELECT COUNT(*) c FROM loans WHERE member_id=? AND returned IS NULL').get(memberId).c >= LOAN_LIMIT)
      throw conflict(`Membro atingiu o limite de ${LOAN_LIMIT} empréstimos.`);
    const r = db.prepare('INSERT INTO loans (book_id,member_id,out,due) VALUES (?,?,?,?)').run(bookId, memberId, out, due);
    log('⇄', `Empréstimo de “${b.title}” para ${m.name}.`);
    return { status: 201, data: loanOut(db.prepare('SELECT * FROM loans WHERE id=?').get(r.lastInsertRowid)) };
  });
});
route('POST', '/api/loans/:id/return', {}, ({ user, params }) => {
  need(user, 'loans');
  const id = int(params.id, { min: 1 });
  const l = db.prepare('SELECT * FROM loans WHERE id=?').get(id);
  if (!l) throw notFound('Empréstimo não encontrado.');
  if (l.returned) throw conflict('Este empréstimo já foi devolvido.');
  db.prepare('UPDATE loans SET returned=? WHERE id=?').run(ago(0), id);
  const b = db.prepare('SELECT title FROM books WHERE id=?').get(l.book_id);
  log('✓', `Devolução registrada: “${b ? b.title : 'livro'}”.`);
  return loanOut(db.prepare('SELECT * FROM loans WHERE id=?').get(id));
});

/* Reservas */
route('POST', '/api/reservations', {}, ({ user, body }) => {
  need(user, 'reservations');
  const bookId = int(body.bookId, { min: 1, name: 'livro' });
  const memberId = int(body.memberId, { min: 1, name: 'membro' });
  const b = db.prepare('SELECT title FROM books WHERE id=?').get(bookId);
  const m = db.prepare('SELECT status FROM members WHERE id=?').get(memberId);
  if (!b) throw notFound('Livro não encontrado.');
  if (!m) throw notFound('Membro não encontrado.');
  if (m.status !== 'Ativo') throw conflict('O membro está inativo.');
  if (db.prepare("SELECT 1 FROM reservations WHERE book_id=? AND member_id=? AND status='Aguardando'").get(bookId, memberId))
    throw conflict('Este membro já tem uma reserva em espera para este livro.');
  const r = db.prepare('INSERT INTO reservations (book_id,member_id,date,status) VALUES (?,?,?,?)').run(bookId, memberId, ago(0), 'Aguardando');
  log('◷', `Reserva criada para “${b.title}”.`);
  return { status: 201, data: resOut(db.prepare('SELECT * FROM reservations WHERE id=?').get(r.lastInsertRowid)) };
});
route('POST', '/api/reservations/:id/notify', {}, ({ user, params }) => {
  need(user, 'reservations');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM reservations WHERE id=?').get(id)) throw notFound('Reserva não encontrada.');
  db.prepare("UPDATE reservations SET status='Disponível — notificado' WHERE id=?").run(id);
  return resOut(db.prepare('SELECT * FROM reservations WHERE id=?').get(id));
});
route('DELETE', '/api/reservations/:id', {}, ({ user, params }) => {
  need(user, 'reservations');
  const id = int(params.id, { min: 1 });
  if (!db.prepare('SELECT 1 FROM reservations WHERE id=?').get(id)) throw notFound('Reserva não encontrada.');
  db.prepare('DELETE FROM reservations WHERE id=?').run(id);
  return { ok: true };
});

/* Exportação CSV (requer gerir Relatórios) */
const csvCell = (x) => {
  let s = String(x ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita injeção de fórmulas no Excel
  return '"' + s.replaceAll('"', '""') + '"';
};
route('GET', '/api/export/:type', {}, ({ user, params }) => {
  need(user, 'reports');
  let rows;
  if (params.type === 'books') {
    rows = [['Título', 'Autor', 'ISBN', 'Categoria', 'Total', 'Disponíveis', 'Localização']];
    for (const b of db.prepare('SELECT * FROM books ORDER BY title COLLATE NOCASE').all())
      rows.push([b.title, b.author, b.isbn, b.category, b.total, b.total - activeLoansOf(b.id), b.location]);
  } else if (params.type === 'loans') {
    rows = [['Livro', 'Membro', 'Empréstimo', 'Devolução prevista', 'Devolvido em', 'Status']];
    const today = ago(0);
    for (const l of db.prepare('SELECT l.*, b.title, m.name FROM loans l LEFT JOIN books b ON b.id=l.book_id LEFT JOIN members m ON m.id=l.member_id ORDER BY l.id').all())
      rows.push([l.title || '', l.name || '', l.out, l.due, l.returned || '', l.returned ? 'Devolvido' : l.due < today ? 'Atrasado' : 'Ativo']);
  } else throw notFound('Relatório desconhecido.');
  return { raw: '﻿' + rows.map((r) => r.map(csvCell).join(';')).join('\n'), type: 'text/csv; charset=utf-8', filename: params.type === 'books' ? 'inventario-biblioteca.csv' : 'emprestimos-biblioteca.csv' };
});

/* ---------- servidor ---------- */
const SEC_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Cache-Control': 'no-store',
};
function send(res, status, payload, headers = {}) {
  const isBuf = typeof payload === 'string' || Buffer.isBuffer(payload);
  const body = isBuf ? payload : JSON.stringify(payload);
  res.writeHead(status, { ...SEC_HEADERS, ...(isBuf ? {} : { 'Content-Type': 'application/json; charset=utf-8' }), ...headers });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'Pedido demasiado grande.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' ? v : {});
      } catch {
        reject(bad('JSON inválido.'));
      }
    });
    req.on('error', reject);
  });
}
function authenticate(req) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const p = m && verifyToken(m[1]);
  if (!p) throw new HttpError(401, 'Sessão inválida ou expirada. Entre novamente.');
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(p.sub);
  if (!u || !u.ativo || u.token_version !== p.tv) throw new HttpError(401, 'Sessão inválida ou expirada. Entre novamente.');
  return u;
}
async function handleApi(req, res, url) {
  const route_ = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route_) {
    if (routes.some((r) => r.re.test(url.pathname))) throw new HttpError(405, 'Método não permitido.');
    throw notFound('Rota não encontrada.');
  }
  const m = route_.re.exec(url.pathname);
  const params = Object.fromEntries(route_.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  const user = route_.auth ? authenticate(req) : null;
  // Troca de senha obrigatória: só permite /me e alterar senha.
  if (user && user.must_change && !['/api/auth/me', '/api/auth/password'].includes(url.pathname))
    throw forbidden('Defina uma nova senha antes de continuar.');
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
  const out = await route_.handler({ req, res, user, body, params, url });
  if (out && out.raw !== undefined)
    return send(res, 200, out.raw, { 'Content-Type': out.type, 'Content-Disposition': `attachment; filename="${out.filename}"` });
  if (out && out.status && out.data !== undefined) return send(res, out.status, out.data);
  send(res, 200, out ?? { ok: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(req, res, url) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Método não permitido.');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (file !== PUBLIC_DIR && !file.startsWith(PUBLIC_DIR + path.sep)) throw notFound();
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw notFound('Página não encontrada.');
  }
  if (!stat.isFile()) throw notFound('Página não encontrada.');
  res.writeHead(200, { ...SEC_HEADERS, 'Cache-Control': 'no-cache', 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Content-Length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) {
    if (res.headersSent) return res.end();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message });
    if (e && /UNIQUE|constraint/i.test(e.message || '')) return send(res, 409, { error: 'Conflito: registo duplicado ou inválido.' });
    console.error(e);
    send(res, 500, { error: 'Erro interno do servidor.' });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Biblioteca Viva a correr em http://localhost:${PORT}`);
    console.log('Contas iniciais: "Administrador" / admin123 (troca obrigatória) e "Ana Martins" / biblioteca123');
  });
}
module.exports = { server };
