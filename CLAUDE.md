# KruBook — working rules

## Branches and releases

- Every change lands on `development` first. Never commit or push straight to `main`.
- Push to `development` runs CI only (typecheck, vitest, Vite build, Playwright e2e).
- Merge `development` into `main` only after CI is green on `development` **and** the owner has
  said "yes, deploy" for that release. A push to `main` deploys production (restarts the app and
  may run migrations), so each deploy needs its own explicit approval.
- Full release flow and server steps: `docs/OPERATIONS.md`.

## Checks before pushing

- `npx vitest run` (add `--no-file-parallelism` if setup hooks time out)
- `npm run build && npm run e2e`

## Production data

- Never re-import the workbook over the live database; it holds data the workbook does not
  (pay statements, rates, the owner's account). Preview workbook changes in a scratch DB with
  `server/import-workbook.ts` and `scripts/merge-scores.ts`; see `docs/OPERATIONS.md`.
