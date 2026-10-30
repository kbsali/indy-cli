# indy-cli

Bun CLI over the unofficial, reverse-engineered Indy web API
(`https://app.indy.fr/api`). No runtime dependencies. Read `README.md` (auth,
commands) and `indy-web-api.md` (endpoints, payloads, gotchas) before touching
`src/client.ts`.

## Commands

```bash
bun install
bun test                  # src/client.test.ts: pure helpers, no network
bun run check             # oxlint && bun fmt --check && bun check
bun run fix               # oxlint --fix && bun fmt
bun run src/cli.ts --help
```

Pre-commit hook `.githooks/pre-commit` (wired by `prepare`): `bun fmt --staged`
then `bunx oxlint`. CI runs `bun test` and `bun run check`.

## Layout

- `src/client.ts`: `IndyClient`, one method per endpoint; pure helpers
  (`buildQuery`, `toCents`, `parseSubdivision`, `normalizeCookie`) are exported
  and unit-tested.
- `src/cli.ts`: `node:util` `parseArgs`, one `case` per command in `main`. The
  `USAGE` string is the help text: update it, and the README "Commands"
  section, with every command or flag change.
- `src/browser-cookie.ts`: reads one cookie from the Chromium/Chrome store.
- `src/format.ts`: TSV (tabs, decimal commas) and aligned text.

## Gotchas

- Real books: `vat`, `split`, `upload`, `attach`, `detach`, `delete-receipt`,
  `apply-receipt` modify the user's accounting data. Never run them to test.
  Read-only commands (`list`, `get`, `receipts`, `unpaired`, `filters`,
  `vat-config`) only when asked.
- Auth is the HttpOnly cookie `__Http-sid`: `INDY_COOKIE`, else the Chromium
  cookie store (`src/browser-cookie.ts`: Linux, libsecret, AES-128-CBC,
  SHA-256 host prefix from meta version 24), else
  `keyring get indy-compta cookie`. A Firebase token alone gets 401. Never
  print or log a cookie value.
- Units: `tvaRate` and `vatRate[]` in basis points (2000 = 20 %); payload
  amounts are signed cents (expenses negative); `amountFrom`/`amountTo` list
  filters are euros. Page size is fixed at 30.
- Omit `tvaIntracom` for French VAT: the API rejects `null`
  (`400 body/tvaIntracom must be object`).
- The full edit route is `POST /transactions/manual/:id`, bank transactions
  included. `split` sends the whole subdivision list; lines must sum to the
  transaction amount to the cent.
- There is no reliable by-id endpoint: `getTransaction` falls back to scanning
  list pages.
- API changes: capture the SPA request in DevTools, then update
  `indy-web-api.md` in the same commit. It is excluded from `bun fmt`.
- `tsconfig.json` needs `"types": ["bun"]`: TypeScript 7 no longer auto-loads
  `@types/*`.

## Workflow

Public repo: never commit to `main`. Work on a branch, open a PR, and
squash-merge only after Kevin approves.
