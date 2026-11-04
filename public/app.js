'use strict';
/* Biblioteca Viva — frontend. Todos os dados vêm da API (/api/*); a sessão usa um token Bearer. */
const TOKEN_KEY = 'biblioteca-viva-token';
const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- API ---------- */
let token = null;
try { token = sessionStorage.getItem(TOKEN_KEY); } catch {}
function setToken(t) {
  token = t;
  try { t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY); } catch {}
}
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Sem ligação ao servidor. Verifique a rede e tente novamente.');
  }
  if (res.status === 401 && token && !url.includes('/auth/login')) {
    lock();
    throw new Error('A sua sessão expirou. Entre novamente.');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json().catch(() => ({})) : null;
  if (!res.ok) throw new Error((data && data.error) || `Erro ${res.status}`);
  return data;
}

/* ---------- dados e utilitários ---------- */
let db = { books: [], members: [], loans: [], reservations: [], activity: [] };
const book = (id) => db.books.find((x) => x.id == id), member = (id) => db.members.find((x) => x.id == id);
const activeLoans = (id) => db.loans.filter((x) => x.bookId == id && !x.returned).length;
function ago(n) { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); }
const fmt = (d) => (d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '—');
const fmtDT = (t) => (t ? new Date(String(t).replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const status = (l) => (l.returned ? 'Devolvido' : l.due < ago(0) ? 'Atrasado' : 'Ativo');
const norm = (t) => (t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().replace(/\s+/g, ' ').toLowerCase();
function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 2800); }
async function reload() { db = await api('GET', '/api/data'); render(); }
/* Executa uma ação da API, recarrega os dados e mostra erro/sucesso. Devolve true se correu bem. */
async function act(fn, okMsg) {
  try { await fn(); await reload(); if (okMsg) toast(okMsg); return true; } catch (e) { toast(e.message); return false; }
}

/* ---------- navegação ---------- */
const pageNames = { dashboard: 'Visão geral', books: 'Acervo de livros', members: 'Membros', loans: 'Empréstimos', reservations: 'Reservas', reports: 'Relatórios', users: 'Usuários' };
let cur = null, forced = false;
const can = (mod, a) => { if (!cur) return false; if (cur.role === 'superadmin') return true; const has = (x) => cur.perms.includes(mod + '.' + x); return a === 'view' ? has('view') : has('view') && has('edit'); };
const isSA = () => !!cur && cur.role === 'superadmin';
const canPage = (p) => (p === 'dashboard' ? true : p === 'users' ? isSA() : can(p, 'view'));
let users = [];
async function go(page) {
  if (!canPage(page)) { toast('Você não tem permissão para acessar esta área.'); return; }
  $$('.section').forEach((x) => x.classList.toggle('active', x.id === page));
  $$('.nav button').forEach((x) => x.classList.toggle('active', x.dataset.page === page));
  $('#pagetitle').textContent = pageNames[page]; $('#crumb').textContent = pageNames[page];
  render();
  if (page === 'users') { try { users = await api('GET', '/api/users'); renderUsers(); } catch (e) { toast(e.message); } }
}
$$('.nav button').forEach((b) => (b.onclick = () => go(b.dataset.page)));
$$('[data-goto]').forEach((b) => (b.onclick = () => go(b.dataset.goto)));
$('#today').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

/* ---------- renderização ---------- */
function render() { renderDashboard(); renderBooks(); renderMembers(); renderLoans(); renderReservations(); renderReports(); }
function pill(s) { return `<span class="pill ${s === 'Atrasado' ? 'red' : s === 'Aguardando' ? 'warn' : s === 'Devolvido' ? 'gray' : ''}">${esc(s)}</span>`; }
function renderDashboard() {
  const total = db.books.reduce((s, b) => s + +b.total, 0), out = db.loans.filter((l) => !l.returned).length, late = db.loans.filter((l) => status(l) === 'Atrasado').length;
  $('#metrics').innerHTML = [['Livros no acervo', total, 'Títulos e exemplares', '▤'], ['Disponíveis', total - out, 'Prontos para empréstimo', '✓'], ['Membros cadastrados', db.members.length, 'Contas ativas', '♙'], ['Em atraso', late, 'Precisam de atenção', '◷']]
    .map((a) => `<div class="metric"><div class="mhead">${a[0]}<span class="micon">${a[3]}</span></div><div class="number">${a[1]}</div><div class="sub">${a[2]}</div></div>`).join('');
  const recent = [...db.loans].sort((a, b) => b.id - a.id).slice(0, 5);
  $('#recentloans').innerHTML = recent.length ? recent.map((l) => `<tr><td><div class="booktitle">${esc(book(l.bookId)?.title || 'Livro removido')}</div><div class="secondary">${esc(member(l.memberId)?.name || '')}</div></td><td>${fmt(l.out)}</td><td>${fmt(l.due)}</td><td>${pill(status(l))}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Nenhum empréstimo cadastrado.</td></tr>';
  const counts = db.books.map((b) => ({ ...b, count: db.loans.filter((l) => l.bookId == b.id).length })).sort((a, b) => b.count - a.count).slice(0, 4);
  $('#popular').innerHTML = counts.map((b) => `<div class="barrow"><span>${esc(b.title.length > 23 ? b.title.slice(0, 23) + '…' : b.title)}</span><div class="track"><div class="fill" style="width:${Math.max(8, (b.count / Math.max(1, counts[0]?.count)) * 100)}%"></div></div><b>${b.count}</b></div>`).join('');
  let acts = db.activity.slice(-4).reverse().map((a) => ({ icon: a.icon, text: a.text, time: fmtDT(a.time) }));
  if (!acts.length) acts = [{ icon: '＋', text: 'Biblioteca Viva está pronta para uso.', time: 'Agora' }, { icon: '▤', text: `${db.books.length} títulos cadastrados no acervo.`, time: 'Hoje' }, { icon: '♙', text: `${db.members.length} membros registrados.`, time: 'Hoje' }];
  $('#activity').innerHTML = acts.map((a) => `<div class="feeditem"><div class="feedicon">${esc(a.icon)}</div><div><div class="feedtext">${esc(a.text)}</div><div class="feedtime">${esc(a.time)}</div></div></div>`).join('');
  const cats = {}; db.books.forEach((b) => (cats[b.category] = (cats[b.category] || 0) + +b.total));
  const c = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#categories').innerHTML = c.length ? c.map(([k, v]) => `<div class="barrow"><span>${esc(k)}</span><div class="track"><div class="fill" style="width:${Math.max(6, (v / Math.max(...c.map((x) => x[1]))) * 100)}%"></div></div><b>${v}</b></div>`).join('') : '<div class="empty">Sem categorias.</div>';
}
function renderBooks() {
  const q = ($('#booksearch')?.value || '').toLowerCase(), cat = $('#bookfilter')?.value || '';
  const cats = [...new Set(db.books.map((b) => b.category))];
  $('#bookfilter').innerHTML = '<option value="">Todas as categorias</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join(''); $('#bookfilter').value = cat;
  const rows = db.books.filter((b) => (!q || `${b.title} ${b.author} ${b.isbn}`.toLowerCase().includes(q)) && (!cat || b.category === cat));
  $('#bookrows').innerHTML = rows.length ? rows.map((b) => { const on = activeLoans(b.id), avail = +b.total - on; return `<tr><td><div class="booktitle">${esc(b.title)}</div><div class="secondary">${esc(b.author)} · ${b.year || '—'}</div></td><td>${esc(b.isbn || '—')}</td><td>${esc(b.category)}</td><td>${avail > 0 ? pill(`${avail} de ${b.total} disponível`) : pill('Indisponível')}</td><td>${esc(b.location || '—')}</td><td><button class="btn small" onclick="editBook(${b.id})">Editar</button> <button class="btn small danger" onclick="deleteBook(${b.id})">Excluir</button></td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">Nenhum livro encontrado.</td></tr>';
}
function renderMembers() {
  const q = ($('#membersearch')?.value || '').toLowerCase();
  const rows = db.members.filter((m) => `${m.name} ${m.email}`.toLowerCase().includes(q));
  $('#memberrows').innerHTML = rows.length ? rows.map((m) => `<tr><td><div class="booktitle">${esc(m.name)}</div><div class="secondary">Desde ${fmt(m.joined)}</div></td><td>${esc(m.email)}<div class="secondary">${esc(m.phone || '')}</div></td><td>${esc(m.type)}</td><td>${db.loans.filter((l) => l.memberId == m.id && !l.returned).length}</td><td>${pill(m.status)}</td><td><button class="btn small" onclick="editMember(${m.id})">Editar</button> <button class="btn small danger" onclick="deleteMember(${m.id})">Excluir</button></td></tr>`).join('') : '<tr><td colspan="6" class="empty">Nenhum membro encontrado.</td></tr>';
}
function renderLoans() {
  const q = ($('#loansearch')?.value || '').toLowerCase(), f = $('#loanfilter')?.value || '';
  const rows = [...db.loans].reverse().filter((l) => (!q || `${book(l.bookId)?.title} ${member(l.memberId)?.name}`.toLowerCase().includes(q)) && (!f || status(l) === f));
  $('#loanrows').innerHTML = rows.length ? rows.map((l) => { const st = status(l), fine = st === 'Atrasado' ? Math.max(0, Math.floor((new Date(ago(0)) - new Date(l.due + 'T12:00:00')) / 86400000)) * 2 : 0; return `<tr><td><div class="booktitle">${esc(book(l.bookId)?.title || 'Livro removido')}</div></td><td>${esc(member(l.memberId)?.name || '')}</td><td>${fmt(l.out)}</td><td>${fmt(l.due)}</td><td>${fine ? `R$ ${fine.toFixed(2)}` : '—'}</td><td>${pill(st)} ${!l.returned ? `<button class="btn small" onclick="returnLoan(${l.id})">Devolver</button>` : ''}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">Nenhum empréstimo encontrado.</td></tr>';
}
function renderReservations() {
  const q = ($('#ressearch')?.value || '').toLowerCase();
  const rows = [...db.reservations].reverse().filter((r) => `${book(r.bookId)?.title} ${member(r.memberId)?.name}`.toLowerCase().includes(q));
  $('#resrows').innerHTML = rows.length ? rows.map((r) => `<tr><td>${esc(book(r.bookId)?.title || 'Livro removido')}</td><td>${esc(member(r.memberId)?.name || '')}</td><td>${fmt(r.date)}</td><td>${pill(r.status)}</td><td>${r.status === 'Aguardando' ? `<button class="btn small" onclick="notifyReservation(${r.id})">Marcar disponível</button>` : ''} <button class="btn small danger" onclick="cancelReservation(${r.id})">Cancelar</button></td></tr>`).join('') : '<tr><td colspan="5" class="empty">Nenhuma reserva cadastrada.</td></tr>';
}
const reportLine = (k, v) => `<div class="reportline"><span>${k}</span><strong>${v}</strong></div>`;
function renderReports() {
  const total = db.books.reduce((s, b) => s + +b.total, 0), out = db.loans.filter((l) => !l.returned).length;
  $('#reportinventory').innerHTML = reportLine('Títulos diferentes', db.books.length) + reportLine('Exemplares totais', total) + reportLine('Disponíveis', total - out) + reportLine('Emprestados', out) + reportLine('Categorias', new Set(db.books.map((b) => b.category)).size);
  $('#reportloans').innerHTML = reportLine('Empréstimos totais', db.loans.length) + reportLine('Ativos', db.loans.filter((l) => !l.returned && status(l) === 'Ativo').length) + reportLine('Em atraso', db.loans.filter((l) => status(l) === 'Atrasado').length) + reportLine('Devolvidos', db.loans.filter((l) => l.returned).length) + reportLine('Membros ativos', db.members.filter((m) => m.status === 'Ativo').length);
  const tops = [...db.books].map((b) => [b.title, db.loans.filter((l) => l.bookId === b.id).length]).sort((a, b) => b[1] - a[1]).slice(0, 5);
  $('#reportpopular').innerHTML = tops.map(([n, v]) => reportLine(esc(n), v + ' empréstimos')).join('') || '<div class="empty">Sem dados.</div>';
  $('#reportactivity').innerHTML = reportLine('Reservas aguardando', db.reservations.filter((r) => r.status === 'Aguardando').length) + reportLine('Multa diária configurada', 'R$ 2,00') + reportLine('Limite de empréstimos por membro', '5') + reportLine('Dados armazenados', 'No servidor');
}

/* ---------- modais e formulários ---------- */
function closeModal() { if (forced) return; $('#modalback').classList.remove('open'); }
function showModal(html) { $('#modalcontent').innerHTML = html; $('#modalback').classList.add('open'); }
function formField(label, name, value = '', type = 'text', opts = null, full = false) {
  return `<div class="field ${full ? 'full' : ''}"><label>${label}</label>${opts ? `<select name="${name}" required>${opts.map((o) => `<option ${o === value ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : `<input name="${name}" type="${type}" value="${esc(value)}" ${name === 'total' ? 'min="1"' : ''} ${name === 'isbn' || name === 'publisher' || name === 'location' || name === 'phone' ? '' : 'required'}>`}</div>`;
}
const formData = (form) => Object.fromEntries(new FormData(form));

function openBook(id = null) {
  const b = id ? book(id) : {};
  showModal(`<h2>${id ? 'Editar livro' : 'Cadastrar livro'}</h2><p class="hint">Preencha os dados principais do título.</p><form id="bookform"><div class="fields">${formField('Título', 'title', b.title || '', 'text', null, true)}${formField('Autor', 'author', b.author || '')}${formField('ISBN', 'isbn', b.isbn || '')}${formField('Editora', 'publisher', b.publisher || '')}${formField('Ano de publicação', 'year', b.year || new Date().getFullYear(), 'number')}${formField('Categoria', 'category', b.category || 'Literatura')}${formField('Quantidade total', 'total', b.total || 1, 'number')}${formField('Localização', 'location', b.location || '')}</div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">Salvar livro</button></div></form>`);
  $('#bookform').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (await act(() => (id ? api('PUT', '/api/books/' + id, d) : api('POST', '/api/books', d)), id ? 'Livro atualizado.' : 'Livro cadastrado.')) closeModal();
  };
}
function editBook(id) { openBook(id); }
async function deleteBook(id) { if (!confirm('Excluir este livro do acervo?')) return; await act(() => api('DELETE', '/api/books/' + id), 'Livro excluído.'); }

function openMember(id = null) {
  const m = id ? member(id) : {};
  showModal(`<h2>${id ? 'Editar membro' : 'Cadastrar membro'}</h2><p class="hint">Cadastre os dados de contato e o perfil do membro.</p><form id="memberform"><div class="fields">${formField('Nome completo', 'name', m.name || '', 'text', null, true)}${formField('E-mail', 'email', m.email || '', 'email')}${formField('Telefone', 'phone', m.phone || '')}${formField('Tipo de usuário', 'type', m.type || 'Membro', 'text', ['Membro', 'Bibliotecário', 'Administrador'])}${formField('Status', 'status', m.status || 'Ativo', 'text', ['Ativo', 'Inativo'])}</div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">Salvar membro</button></div></form>`);
  $('#memberform').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (await act(() => (id ? api('PUT', '/api/members/' + id, d) : api('POST', '/api/members', d)), id ? 'Membro atualizado.' : 'Membro cadastrado.')) closeModal();
  };
}
function editMember(id) { openMember(id); }
async function deleteMember(id) {
  if (db.loans.some((l) => l.memberId == id && !l.returned)) { toast('Encerre os empréstimos ativos antes de excluir.'); return; }
  if (!confirm('Excluir este membro?')) return;
  await act(() => api('DELETE', '/api/members/' + id), 'Membro excluído.');
}

/* Caixa de pesquisa com sugestões (livro/membro) */
function mkCombo(root, items) {
  const inp = root.querySelector('.comboinput'), hid = root.querySelector('input[type=hidden]'), list = root.querySelector('.combolist'), nz = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  let shown = [], actI = -1;
  function draw() {
    const q = nz(inp.value).trim(); shown = items.filter((i) => !q || nz(i.search).includes(q)).slice(0, 40); actI = shown.length ? 0 : -1;
    list.innerHTML = shown.length ? shown.map((i, k) => `<div class="comboitem${k === actI ? ' active' : ''}" data-k="${k}"><b>${esc(i.label)}</b><span>${esc(i.sub)}</span></div>`).join('') : '<div class="comboempty">Nada encontrado.</div>';
  }
  const open = () => { root.classList.add('open'); draw(); }, close = () => root.classList.remove('open'), pick = (i) => { hid.value = i.id; inp.value = i.label; inp.style.borderColor = ''; close(); };
  inp.addEventListener('focus', () => { inp.select(); open(); }); inp.addEventListener('click', open); inp.addEventListener('input', () => { hid.value = ''; inp.style.borderColor = ''; open(); });
  inp.addEventListener('keydown', (e) => {
    if (!root.classList.contains('open')) { if (e.key === 'ArrowDown') { e.preventDefault(); open(); } return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); if (!shown.length) return; actI = (actI + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length; [...list.children].forEach((c, k) => c.classList.toggle('active', k === actI)); list.children[actI].scrollIntoView({ block: 'nearest' }); }
    else if (e.key === 'Enter') { e.preventDefault(); if (actI >= 0) pick(shown[actI]); } else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => { const el = e.target.closest('.comboitem'); if (!el) return; e.preventDefault(); pick(shown[+el.dataset.k]); });
  inp.addEventListener('blur', () => setTimeout(close, 120));
}
function initLoanCombos() {
  mkCombo($('#combobook'), db.books.filter((b) => b.total > activeLoans(b.id)).map((b) => { const av = b.total - activeLoans(b.id); return { id: b.id, label: b.title, sub: `${b.author} · ${av} ${av === 1 ? 'disponível' : 'disponíveis'}`, search: `${b.title} ${b.author} ${b.isbn}` }; }));
  mkCombo($('#combomember'), db.members.filter((m) => m.status === 'Ativo').map((m) => { const n = db.loans.filter((l) => l.memberId == m.id && !l.returned).length; return { id: m.id, label: m.name, sub: `${m.email || m.phone || ''} · ${n} ${n === 1 ? 'empréstimo ativo' : 'empréstimos ativos'}`, search: `${m.name} ${m.email} ${m.phone}` }; }));
}
function openLoan() {
  if (!db.books.length || !db.members.length) { toast('Cadastre livros e membros antes de criar empréstimos.'); return; }
  showModal(`<h2>Novo empréstimo</h2><p class="hint">Prazo padrão de 14 dias. Limite de 5 empréstimos ativos por membro.</p><form id="loanform"><div class="fields"><div class="field full"><label>Livro</label><div class="combo" id="combobook"><input class="comboinput" type="text" placeholder="Digite o título, autor ou ISBN..." autocomplete="off"><input type="hidden" name="bookId"><div class="combolist"></div></div></div><div class="field full"><label>Membro</label><div class="combo" id="combomember"><input class="comboinput" type="text" placeholder="Digite o nome do membro..." autocomplete="off"><input type="hidden" name="memberId"><div class="combolist"></div></div></div>${formField('Data de saída', 'out', ago(0), 'date')}${formField('Devolução prevista', 'due', ago(-14), 'date')}</div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">Registrar empréstimo</button></div></form>`);
  initLoanCombos();
  $('#loanform').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (!d.bookId) { toast('Escolha um livro da lista.'); $('#combobook .comboinput').style.borderColor = '#bd5b50'; return; }
    if (!d.memberId) { toast('Escolha um membro da lista.'); $('#combomember .comboinput').style.borderColor = '#bd5b50'; return; }
    if (await act(() => api('POST', '/api/loans', { bookId: +d.bookId, memberId: +d.memberId, out: d.out, due: d.due }), 'Empréstimo registrado.')) closeModal();
  };
}
async function returnLoan(id) { await act(() => api('POST', `/api/loans/${id}/return`), 'Devolução registrada.'); }

function openReservation() {
  if (!db.books.length || !db.members.length) { toast('Cadastre livros e membros primeiro.'); return; }
  showModal(`<h2>Nova reserva</h2><p class="hint">Registre o interesse em um título indisponível.</p><form id="resform"><div class="fields"><div class="field full"><label>Livro</label><select name="bookId" required>${db.books.map((b) => `<option value="${b.id}">${esc(b.title)} — ${activeLoans(b.id) >= b.total ? 'Indisponível' : 'Disponível'}</option>`).join('')}</select></div><div class="field full"><label>Membro</label><select name="memberId" required>${db.members.filter((m) => m.status === 'Ativo').map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('')}</select></div></div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">Criar reserva</button></div></form>`);
  $('#resform').onsubmit = async (e) => {
    e.preventDefault();
    const d = formData(e.target);
    if (await act(() => api('POST', '/api/reservations', { bookId: +d.bookId, memberId: +d.memberId }), 'Reserva criada.')) closeModal();
  };
}
async function notifyReservation(id) {
  const r = db.reservations.find((x) => x.id === id);
  await act(() => api('POST', `/api/reservations/${id}/notify`), `Disponibilidade de “${book(r?.bookId)?.title || 'livro'}” marcada; notificação simulada.`);
}
async function cancelReservation(id) { await act(() => api('DELETE', '/api/reservations/' + id), 'Reserva cancelada.'); }

async function exportCSV(type) {
  try {
    const res = await fetch('/api/export/' + type, { headers: { Authorization: 'Bearer ' + token } });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Falha ao exportar.');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = type === 'books' ? 'inventario-biblioteca.csv' : 'emprestimos-biblioteca.csv';
    a.click(); URL.revokeObjectURL(a.href); toast('Relatório exportado em CSV.');
  } catch (e) { toast(e.message); }
}
['booksearch', 'membersearch', 'loansearch', 'ressearch'].forEach((id) => document.getElementById(id).addEventListener('input', render));
$('#bookfilter').addEventListener('change', renderBooks); $('#loanfilter').addEventListener('change', renderLoans);

/* ---------- permissões na interface (o servidor valida tudo de novo) ---------- */
const GUARDS = { openBook: 'books', editBook: 'books', deleteBook: 'books', openMember: 'members', editMember: 'members', deleteMember: 'members', openLoan: 'loans', returnLoan: 'loans', openReservation: 'reservations', notifyReservation: 'reservations', cancelReservation: 'reservations', exportCSV: 'reports' };
function applyPerms() {
  $$('.nav button[data-page]').forEach((b) => (b.style.display = canPage(b.dataset.page) ? '' : 'none'));
  $$('[data-goto]').forEach((b) => (b.style.display = canPage(b.dataset.goto) ? '' : 'none'));
  $$('[onclick]').forEach((el) => { const m = /^\s*(\w+)\(/.exec(el.getAttribute('onclick') || ''); const mod = m && GUARDS[m[1]]; if (mod) el.style.display = can(mod, 'edit') ? '' : 'none'; });
}
let pending = false;
new MutationObserver(() => { if (pending || !cur) return; pending = true; queueMicrotask(() => { pending = false; applyPerms(); }); }).observe($('.main'), { childList: true, subtree: true });

/* ---------- login / sessão ---------- */
const form = $('#loginform'), nameI = $('#loginname'), passI = $('#loginpass'), err = $('#loginerr');
const logo = document.querySelector('.brandicon img'); if (logo) $('#loginlogo').src = logo.src;
function applyUser(u) {
  const parts = u.nome.split(' ');
  $('#username').textContent = u.nome; $('#userrole').textContent = u.role === 'superadmin' ? 'Super admin' : (u.cargo || '');
  $('#useravatar').textContent = (parts[0][0] + (parts[1] ? parts[parts.length - 1][0] : '')).toUpperCase(); $('#welcomename').textContent = parts[0];
}
async function enter(u) {
  cur = u; applyUser(u); document.body.classList.remove('locked'); applyPerms();
  if (u.mustChange) { openMyPass(true); return; }
  try { await reload(); } catch (e) { toast(e.message); }
  applyPerms(); go('dashboard');
}
function lock() {
  cur = null; forced = false; setToken(null); db = { books: [], members: [], loans: [], reservations: [], activity: [] }; users = [];
  closeModal(); $('#modalback').classList.remove('open'); document.body.classList.add('locked'); passI.value = ''; err.textContent = '';
  setTimeout(() => nameI.focus(), 50);
}
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!nameI.value.trim() || !passI.value) { err.textContent = 'Preencha o nome e a senha.'; return; }
  const btn = form.querySelector('button[type=submit], button.loginbtn'); if (btn) btn.disabled = true;
  try {
    const r = await api('POST', '/api/auth/login', { nome: nameI.value, senha: passI.value });
    setToken(r.token); err.textContent = ''; nameI.value = ''; passI.value = ''; await enter(r.user);
  } catch (ex) {
    err.textContent = ex.message; form.classList.remove('shake'); void form.offsetWidth; form.classList.add('shake'); passI.select();
  } finally { if (btn) btn.disabled = false; }
});
$('#showpass').addEventListener('click', () => { const show = passI.type === 'password'; passI.type = show ? 'text' : 'password'; $('#showpass').textContent = show ? 'Ocultar' : 'Mostrar'; $('#showpass').setAttribute('aria-label', show ? 'Ocultar senha' : 'Mostrar senha'); });
$('#logout').addEventListener('click', lock);
$('#mypass').addEventListener('click', () => openMyPass(false));

const pwField = (label, name, ac) => `<div class="field full"><label>${label}</label><input name="${name}" type="password" autocomplete="${ac}" required></div>`;
function openMyPass(force) {
  forced = !!force;
  showModal(`<h2>${force ? 'Defina uma nova senha' : 'Alterar minha senha'}</h2><p class="hint">${force ? 'Por segurança, troque a senha provisória antes de continuar.' : 'Use pelo menos 6 caracteres.'}</p><form id="passform"><div class="fields">${force ? '' : pwField('Senha atual', 'cur', 'current-password')}${pwField('Nova senha', 'pw1', 'new-password')}${pwField('Confirmar nova senha', 'pw2', 'new-password')}</div><div class="loginerr" id="passerr" style="margin-top:12px"></div><div class="modalactions">${force ? '<button type="button" class="btn" id="passout">Sair</button>' : '<button type="button" class="btn" onclick="closeModal()">Cancelar</button>'}<button class="btn primary">Salvar senha</button></div></form>`);
  const f = $('#passform'), perr = (t) => ($('#passerr').textContent = t);
  if (force) $('#passout').onclick = lock;
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = new FormData(f), p1 = d.get('pw1');
    if (p1.length < 6) return perr('A nova senha deve ter pelo menos 6 caracteres.');
    if (p1 !== d.get('pw2')) return perr('As senhas não coincidem.');
    try {
      const r = await api('POST', '/api/auth/password', { atual: force ? undefined : d.get('cur'), nova: p1 });
      setToken(r.token); cur = r.user; forced = false; closeModal(); toast('Senha alterada com sucesso.');
      applyUser(cur); await reload(); applyPerms(); go('dashboard');
    } catch (ex) { perr(ex.message); }
  };
}

/* ---------- gestão de usuários (super admin) ---------- */
const MODS = [['books', 'Acervo de livros', 'Livros'], ['members', 'Membros', 'Membros'], ['loans', 'Empréstimos', 'Empréstimos'], ['reservations', 'Reservas', 'Reservas'], ['reports', 'Relatórios (gerir = exportar CSV)', 'Relatórios']];
const VIEW_ALL = MODS.map((m) => m[0] + '.view');
function permSummary(u) {
  if (u.role === 'superadmin') return 'Acesso total + gestão de usuários';
  const p = MODS.map((m) => (u.perms.includes(m[0] + '.view') ? (u.perms.includes(m[0] + '.edit') ? m[2] + ' (gerir)' : m[2] + ' (ver)') : null)).filter(Boolean);
  return p.length ? p.join(' · ') : 'Somente painel inicial';
}
function renderUsers() {
  if (!isSA()) return;
  const q = norm($('#usersearch').value), rows = users.filter((u) => !q || norm(u.nome + ' ' + u.cargo).includes(q));
  $('#userrows').innerHTML = rows.length ? rows.map((u) => { const me = u.id === cur.id; return `<tr><td><div class="booktitle">${esc(u.nome)}${me ? ' <span class="secondary">(você)</span>' : ''}</div><div class="secondary">${esc(u.cargo || '—')}</div></td><td>${u.role === 'superadmin' ? '<span class="pill warn">Super admin</span>' : '<span class="pill gray">Usuário</span>'}</td><td class="permcell">${esc(permSummary(u))}</td><td>${u.ativo ? '<span class="pill">Ativo</span>' : '<span class="pill gray">Inativo</span>'}${u.mustChange ? '<div class="secondary">Troca de senha pendente</div>' : ''}</td><td>${u.ultimoAcesso ? fmtDT(u.ultimoAcesso) : 'Nunca'}</td><td class="actcell"><button class="btn small" data-act="edit" data-id="${u.id}">Editar</button> <button class="btn small" data-act="pass" data-id="${u.id}">Senha</button>${me ? '' : ` <button class="btn small" data-act="toggle" data-id="${u.id}">${u.ativo ? 'Desativar' : 'Ativar'}</button> <button class="btn small danger" data-act="del" data-id="${u.id}">Excluir</button>`}</td></tr>`; }).join('') : '<tr><td colspan="6" class="empty">Nenhum usuário encontrado.</td></tr>';
}
async function refreshUsers(okMsg) {
  try { users = await api('GET', '/api/users'); renderUsers(); if (okMsg) toast(okMsg); } catch (e) { toast(e.message); }
}
function openUser(id) {
  if (!isSA()) return;
  const u = id ? users.find((x) => x.id === id) : null, isNew = !u, perms = u ? u.perms : VIEW_ALL;
  showModal(`<h2>${isNew ? 'Novo usuário' : 'Editar usuário'}</h2><p class="hint">Defina quem é a pessoa e o que ela pode fazer no sistema.</p><form id="userform" autocomplete="off"><div class="fields"><div class="field full"><label>Nome (usado para entrar)</label><input name="nome" value="${esc(u ? u.nome : '')}" required></div><div class="field"><label>Cargo</label><input name="cargo" value="${esc(u ? u.cargo : '')}"></div><div class="field"><label>Perfil</label><select name="perfil"><option value="user" ${(u && u.role === 'user') || isNew ? 'selected' : ''}>Usuário</option><option value="superadmin" ${u && u.role === 'superadmin' ? 'selected' : ''}>Super admin</option></select></div><div class="field"><label>Estado</label><select name="ativo"><option value="1" ${!u || u.ativo ? 'selected' : ''}>Ativo</option><option value="0" ${u && !u.ativo ? 'selected' : ''}>Inativo</option></select></div>${isNew ? '<div class="field"><label>Senha inicial</label><input name="senha" type="password" autocomplete="new-password" minlength="6" required></div><label class="check field full"><input type="checkbox" name="must" checked> Exigir troca de senha no primeiro acesso</label>' : ''}</div>
  <div id="sanote" class="permnote" style="display:none;margin-top:16px">Super admin tem acesso total e pode gerenciar usuários, senhas e permissões.</div>
  <div id="permbox"><div class="permhead"><b>Permissões</b><span><button type="button" class="btn small" data-preset="all">Acesso total</button> <button type="button" class="btn small" data-preset="view">Somente consulta</button> <button type="button" class="btn small" data-preset="none">Limpar</button></span></div><div class="permgrid"><div class="ph">Área</div><div class="ph">Ver</div><div class="ph">Gerir</div>${MODS.map((m) => `<div>${m[1]}</div><div><input type="checkbox" data-p="${m[0]}.view"></div><div><input type="checkbox" data-p="${m[0]}.edit"></div>`).join('')}</div><p class="permnote">Gerir = cadastrar, editar, excluir e registrar. O painel inicial fica sempre disponível.</p></div>
  <div class="loginerr" id="usererr" style="margin-top:12px"></div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">${isNew ? 'Criar usuário' : 'Salvar alterações'}</button></div></form>`);
  const f = $('#userform'), box = $('#permbox'), cbs = () => [...box.querySelectorAll('input[data-p]')], uerr = (t) => ($('#usererr').textContent = t);
  cbs().forEach((c) => (c.checked = perms.includes(c.dataset.p)));
  box.addEventListener('change', (e) => { const c = e.target; if (!c.dataset || !c.dataset.p) return; const [m, a] = c.dataset.p.split('.'), v = box.querySelector(`[data-p="${m}.view"]`), ed = box.querySelector(`[data-p="${m}.edit"]`); if (a === 'edit' && c.checked) v.checked = true; if (a === 'view' && !c.checked) ed.checked = false; });
  box.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => { const p = b.dataset.preset; cbs().forEach((c) => (c.checked = p === 'all' || (p === 'view' && c.dataset.p.endsWith('.view')))); }));
  const sync = () => { const sa = f.elements.perfil.value === 'superadmin'; box.style.display = sa ? 'none' : ''; $('#sanote').style.display = sa ? '' : 'none'; }; f.elements.perfil.onchange = sync; sync();
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = new FormData(f), nome = String(d.get('nome')).trim().replace(/\s+/g, ' '), perfil = d.get('perfil');
    if (!nome) return uerr('Informe o nome.');
    if (u && u.id === cur.id && perfil !== 'superadmin' && !confirm('Você vai perder o acesso de super admin. Continuar?')) return;
    const payload = { nome, cargo: String(d.get('cargo')).trim(), role: perfil, ativo: d.get('ativo') === '1', perms: perfil === 'superadmin' ? [] : cbs().filter((c) => c.checked).map((c) => c.dataset.p) };
    try {
      if (u) {
        const r = await api('PUT', '/api/users/' + u.id, payload);
        if (u.id === cur.id) { cur = { ...cur, ...r }; applyUser(cur); }
      } else {
        payload.senha = String(d.get('senha') || ''); payload.mustChange = d.get('must') === 'on';
        await api('POST', '/api/users', payload);
      }
      closeModal(); applyPerms(); if (!canPage(($('.section.active') || {}).id)) go('dashboard');
      await refreshUsers(isNew ? 'Usuário criado.' : 'Usuário atualizado.');
    } catch (ex) { uerr(ex.message); }
  };
}
function openReset(id) {
  if (!isSA()) return;
  const u = users.find((x) => x.id === id); if (!u) return;
  showModal(`<h2>Redefinir senha</h2><p class="hint">Nova senha para <b>${esc(u.nome)}</b>. Combine com a pessoa como ela vai recebê-la.</p><form id="resetform" autocomplete="off"><div class="fields">${pwField('Nova senha', 'pw1', 'new-password')}${pwField('Confirmar nova senha', 'pw2', 'new-password')}<label class="check field full"><input type="checkbox" name="must" checked> Exigir troca de senha no próximo acesso</label></div><div class="loginerr" id="reseterr" style="margin-top:12px"></div><div class="modalactions"><button type="button" class="btn" onclick="closeModal()">Cancelar</button><button class="btn primary">Redefinir senha</button></div></form>`);
  const f = $('#resetform'), rerr = (t) => ($('#reseterr').textContent = t);
  f.onsubmit = async (e) => {
    e.preventDefault();
    const d = new FormData(f), p1 = d.get('pw1');
    if (p1.length < 6) return rerr('A senha deve ter pelo menos 6 caracteres.');
    if (p1 !== d.get('pw2')) return rerr('As senhas não coincidem.');
    try { await api('POST', `/api/users/${id}/password`, { senha: p1, mustChange: d.get('must') === 'on' }); closeModal(); await refreshUsers('Senha de ' + u.nome + ' redefinida.'); } catch (ex) { rerr(ex.message); }
  };
}
async function toggleUser(id) { try { const r = await api('POST', `/api/users/${id}/toggle`); await refreshUsers(r.ativo ? 'Usuário ativado.' : 'Usuário desativado.'); } catch (e) { toast(e.message); } }
async function delUser(id) {
  const u = users.find((x) => x.id === id); if (!u) return;
  if (!confirm('Excluir o usuário “' + u.nome + '”? Esta ação não pode ser desfeita.')) return;
  try { await api('DELETE', '/api/users/' + id); await refreshUsers('Usuário excluído.'); } catch (e) { toast(e.message); }
}
$('#newuser').addEventListener('click', () => openUser());
$('#usersearch').addEventListener('input', renderUsers);
$('#userrows').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]'); if (!b) return;
  const id = +b.dataset.id, a = b.dataset.act;
  if (a === 'edit') openUser(id); else if (a === 'pass') (id === cur.id ? openMyPass(false) : openReset(id)); else if (a === 'toggle') toggleUser(id); else if (a === 'del') delUser(id);
});

/* ---------- arranque: restaurar sessão ---------- */
$('#modalback').addEventListener('click', (e) => { if (e.target === $('#modalback')) closeModal(); });
(async () => {
  if (token) {
    try { const r = await api('GET', '/api/auth/me'); await enter(r.user); return; } catch { setToken(null); }
  }
  setTimeout(() => nameI.focus(), 50);
})();
