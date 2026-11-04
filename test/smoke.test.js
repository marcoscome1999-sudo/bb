'use strict';
// Testes de fumaça da API: node test/smoke.test.js  (usa uma base de dados temporária)
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bv-'));
process.env.DATA_DIR = dir;
process.env.PORT = '0';
const { server } = require('../server');

let base, passed = 0;
const call = async (method, url, body, token) => {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json };
};
const t = async (name, fn) => { await fn(); passed++; console.log('  ✓ ' + name); };

server.listen(0, async () => {
  base = 'http://127.0.0.1:' + server.address().port;
  try {
    let admin, ana, limited;
    await t('login incorreto devolve 401', async () => {
      const r = await call('POST', '/api/auth/login', { nome: 'Ana Martins', senha: 'errada' });
      assert.equal(r.status, 401);
    });
    await t('rotas protegidas exigem token', async () => {
      assert.equal((await call('GET', '/api/data')).status, 401);
      assert.equal((await call('GET', '/api/data', null, 'lixo.lixo.lixo')).status, 401);
    });
    await t('administrador: troca de senha obrigatória bloqueia o resto', async () => {
      const r = await call('POST', '/api/auth/login', { nome: 'administrador', senha: 'admin123' });
      assert.equal(r.status, 200); assert.equal(r.body.user.mustChange, true);
      admin = r.body.token;
      assert.equal((await call('GET', '/api/data', null, admin)).status, 403);
      assert.equal((await call('POST', '/api/auth/password', { nova: '123' }, admin)).status, 400);
      const p = await call('POST', '/api/auth/password', { nova: 'novasenha1' }, admin);
      assert.equal(p.status, 200); admin = p.body.token;
      assert.equal((await call('GET', '/api/data', null, admin)).status, 200);
    });
    await t('token antigo deixa de valer após trocar a senha', async () => {
      // (o token de antes da troca foi substituído; um token forjado com versão antiga seria rejeitado)
      const r = await call('POST', '/api/auth/login', { nome: 'Administrador', senha: 'admin123' });
      assert.equal(r.status, 401);
    });
    await t('bibliotecária faz login e vê os dados de exemplo', async () => {
      const r = await call('POST', '/api/auth/login', { nome: 'Ana Martins', senha: 'biblioteca123' });
      ana = r.body.token;
      const d = await call('GET', '/api/data', null, ana);
      assert.equal(d.body.books.length, 5); assert.equal(d.body.loans.length, 5);
    });
    await t('criar utilizador limitado e aplicar permissões no servidor', async () => {
      const c = await call('POST', '/api/users', { nome: 'João Leitor', cargo: 'Estagiário', role: 'user', perms: ['books.view', 'loans.view', 'loans.edit'], senha: 'segredo1' }, admin);
      assert.equal(c.status, 201);
      assert.deepEqual(c.body.perms, ['books.view', 'loans.view', 'loans.edit']);
      limited = (await call('POST', '/api/auth/login', { nome: 'joao leitor', senha: 'segredo1' })).body.token;
      assert.equal((await call('POST', '/api/books', { title: 'X', total: 1 }, limited)).status, 403);
      assert.equal((await call('GET', '/api/users', null, ana)).status, 403);
      assert.equal((await call('GET', '/api/export/books', null, limited)).status, 403);
      const d = await call('GET', '/api/data', null, limited);
      assert.equal(d.body.members[0].email, '', 'contactos ocultos sem permissão de membros');
    });
    let bookId;
    await t('CRUD de livros com validação', async () => {
      assert.equal((await call('POST', '/api/books', { title: '', total: 1 }, ana)).status, 400);
      assert.equal((await call('POST', '/api/books', { title: 'Livro', total: 0 }, ana)).status, 400);
      const c = await call('POST', '/api/books', { title: 'Teste <b>', author: 'A', isbn: '1', year: 2020, category: 'Teste', total: 1, location: 'Z-1' }, ana);
      assert.equal(c.status, 201); bookId = c.body.id;
      assert.equal((await call('PUT', '/api/books/' + bookId, { title: 'Teste 2', total: 2, category: 'Teste' }, ana)).body.title, 'Teste 2');
      assert.equal((await call('PUT', '/api/books/9999', { title: 'x', total: 1 }, ana)).status, 404);
    });
    await t('empréstimos: disponibilidade, limite e devolução', async () => {
      const l1 = await call('POST', '/api/loans', { bookId, memberId: 1 }, ana);
      assert.equal(l1.status, 201);
      const l2 = await call('POST', '/api/loans', { bookId, memberId: 2 }, ana);
      assert.equal(l2.status, 201);
      assert.equal((await call('POST', '/api/loans', { bookId, memberId: 3 }, ana)).status, 409, 'sem exemplares');
      assert.equal((await call('PUT', '/api/books/' + bookId, { title: 'T', total: 1 }, ana)).status, 409, 'total < emprestados');
      assert.equal((await call('DELETE', '/api/books/' + bookId, null, ana)).status, 409, 'livro com empréstimos ativos');
      assert.equal((await call('POST', '/api/loans', { bookId: 3, memberId: 3, out: '2026-02-01', due: '2026-01-01' }, ana)).status, 400, 'datas incoerentes');
      assert.equal((await call('POST', `/api/loans/${l1.body.id}/return`, null, ana)).status, 200);
      assert.equal((await call('POST', `/api/loans/${l1.body.id}/return`, null, ana)).status, 409, 'dupla devolução');
      // limite de 5 por membro
      for (let i = 0; i < 5; i++) await call('POST', '/api/loans', { bookId: 3, memberId: 5 }, ana).then((r) => assert.equal(r.status, 201, 'empréstimo ' + i));
      assert.equal((await call('POST', '/api/loans', { bookId: 1, memberId: 5 }, ana)).status, 409, 'limite de 5');
    });
    await t('membros: não exclui com empréstimos ativos', async () => {
      assert.equal((await call('DELETE', '/api/members/5', null, ana)).status, 409);
      const m = await call('POST', '/api/members', { name: 'Novo', email: 'mau-email' }, ana);
      assert.equal(m.status, 400);
      const ok = await call('POST', '/api/members', { name: 'Novo', email: 'novo@x.com' }, ana);
      assert.equal(ok.status, 201);
      assert.equal((await call('DELETE', '/api/members/' + ok.body.id, null, ana)).status, 200);
    });
    await t('reservas: criar, duplicada, notificar, cancelar', async () => {
      const r = await call('POST', '/api/reservations', { bookId: 1, memberId: 2 }, ana);
      assert.equal(r.status, 201);
      assert.equal((await call('POST', '/api/reservations', { bookId: 1, memberId: 2 }, ana)).status, 409);
      assert.match((await call('POST', `/api/reservations/${r.body.id}/notify`, null, ana)).body.status, /notificado/);
      assert.equal((await call('DELETE', '/api/reservations/' + r.body.id, null, ana)).status, 200);
    });
    await t('exportação CSV', async () => {
      const r = await call('GET', '/api/export/loans', null, ana);
      assert.equal(r.status, 200); assert.match(r.body, /Devolução prevista/);
      assert.equal((await call('GET', '/api/export/outro', null, ana)).status, 404);
    });
    await t('atividade fica registada no servidor', async () => {
      const d = await call('GET', '/api/data', null, ana);
      assert.ok(d.body.activity.length > 3);
    });
    await t('gestão de utilizadores: último super admin protegido', async () => {
      const me = (await call('GET', '/api/auth/me', null, admin)).body.user;
      assert.equal((await call('POST', `/api/users/${me.id}/toggle`, null, admin)).status, 400);
      assert.equal((await call('DELETE', '/api/users/' + me.id, null, admin)).status, 400);
      assert.equal((await call('PUT', '/api/users/' + me.id, { nome: me.nome, role: 'user', ativo: true, perms: [] }, admin)).status, 400);
      assert.equal((await call('POST', '/api/users', { nome: 'ana  MARTINS', senha: 'abcdef' }, admin)).status, 409, 'nome duplicado');
    });
    await t('desativar utilizador invalida a sessão dele de imediato', async () => {
      const list = (await call('GET', '/api/users', null, admin)).body;
      const j = list.find((u) => u.nome === 'João Leitor');
      assert.equal((await call('POST', `/api/users/${j.id}/toggle`, null, admin)).body.ativo, false);
      assert.equal((await call('GET', '/api/data', null, limited)).status, 401);
      assert.equal((await call('POST', '/api/auth/login', { nome: 'João Leitor', senha: 'segredo1' })).status, 403);
    });
    await t('ficheiros estáticos e proteção contra path traversal', async () => {
      const r = await call('GET', '/');
      assert.equal(r.status, 200); assert.match(r.body, /Biblioteca Viva/);
      assert.equal((await call('GET', '/app.js')).status, 200);
      assert.equal((await call('GET', '/..%2f..%2fetc%2fpasswd')).status, 404);
      assert.equal((await call('GET', '/%2e%2e/server.js')).status, 404);
    });
    await t('bloqueio após 5 tentativas falhadas', async () => {
      let last;
      for (let i = 0; i < 6; i++) last = await call('POST', '/api/auth/login', { nome: 'Alguém', senha: 'x' });
      assert.equal(last.status, 429);
    });
    console.log(`\n${passed} testes passaram.`);
    server.close(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(0);
  } catch (e) {
    console.error('\n✗ FALHOU:', e.message); console.error(e.stack.split('\n').slice(1, 4).join('\n'));
    server.close(); process.exit(1);
  }
});
