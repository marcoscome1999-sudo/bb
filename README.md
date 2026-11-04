# Biblioteca Viva — com backend real

API REST + base de dados SQLite + frontend. **Sem dependências npm**: usa apenas módulos do Node.js 22
(`node:http`, `node:sqlite`, `node:crypto`). Basta ter o **Node 22.13 ou superior**.

## Executar

```bash
node server.js            # http://localhost:3000
npm test                  # 16 testes de fumaça da API (base de dados temporária)
```

Contas criadas na primeira execução:

| Nome            | Senha           | Notas                                   |
|-----------------|-----------------|-----------------------------------------|
| Administrador   | `admin123`      | super admin; **obriga a trocar a senha** |
| Ana Martins     | `biblioteca123` | bibliotecária, acesso total às áreas     |

Altere a senha inicial do administrador antes de publicar: `ADMIN_PASSWORD=... node server.js` (só vale na 1.ª execução).

## Variáveis de ambiente

| Variável          | Padrão             | Descrição                                           |
|-------------------|--------------------|-----------------------------------------------------|
| `PORT`            | `3000`             | Porta HTTP                                          |
| `DATA_DIR`        | `./data`           | Pasta da base de dados (`biblioteca.db`) e do segredo |
| `JWT_SECRET`      | gerado em `data/`  | Segredo de assinatura dos tokens                    |
| `TOKEN_TTL_HOURS` | `12`               | Validade da sessão                                  |
| `ADMIN_PASSWORD`  | `admin123`         | Senha inicial do super admin                        |
| `SEED_DEMO`       | `1`                | `0` = não inserir livros/membros de demonstração    |

**Backup:** copie a pasta `data/` (com o servidor parado, ou use `sqlite3 biblioteca.db ".backup ..."`).

## Estrutura

```
server.js      rotas da API, validação, regras de negócio, ficheiros estáticos
db.js          esquema SQLite + dados iniciais
auth.js        hash de senhas (scrypt) e tokens HS256
public/        index.html + app.js (frontend)
test/          testes de fumaça
```

## API (resumo) — cabeçalho `Authorization: Bearer <token>`

- `POST /api/auth/login` · `GET /api/auth/me` · `POST /api/auth/password`
- `GET /api/data` — livros, membros, empréstimos, reservas e atividade
- `POST|PUT|DELETE /api/books[/:id]` · `/api/members[/:id]`
- `POST /api/loans` · `POST /api/loans/:id/return`
- `POST /api/reservations` · `POST /api/reservations/:id/notify` · `DELETE /api/reservations/:id`
- `GET /api/export/books|loans` — CSV
- `GET|POST /api/users` · `PUT|DELETE /api/users/:id` · `POST /api/users/:id/password|toggle` (super admin)
- `GET /api/health`

## O que passou a ser garantido no servidor

- Permissões por área (ver/gerir) validadas em cada pedido; contactos de membros ocultos sem permissão de Membros.
- Livro sem exemplares livres não pode ser emprestado; limite de 5 empréstimos ativos por membro; membro inativo não empresta.
- Não se exclui livro/membro com empréstimos ativos; o total de um livro não desce abaixo dos emprestados.
- Senhas com scrypt (nunca em texto); desativar/redefinir senha invalida as sessões desse utilizador de imediato.
- Bloqueio de 30 s após 5 tentativas de login falhadas; deve existir sempre um super admin ativo.
- CSV protegido contra injeção de fórmulas; HTML do histórico de atividade é escapado no ecrã.

## Produção

Coloque atrás de HTTPS (Nginx/Caddy) e defina `JWT_SECRET` e `ADMIN_PASSWORD`. O servidor é um único processo;
para vários servidores seria preciso trocar o SQLite por PostgreSQL.
