# Data store: JSON → SQLite

The store runs on one of two interchangeable backends. The domain logic in
`server/store/store.ts` is identical for both; only the backend differs.

| Backend | File | Use |
| --- | --- | --- |
| `JsonBackend` | `wicksentinel.json` | Original engine. Retained for rollback. |
| `SqliteBackend` | `wicksentinel.db` | Transactional engine. Target state. |

`STORAGE_ENGINE` selects one:

- `auto` (default) — SQLite when `wicksentinel.db` exists, JSON otherwise.
- `json` — force the JSON file.
- `sqlite` — force SQLite.

Because `auto` keys off the presence of the database file, migrating a
deployment switches it over with no environment change, and deleting the
database file rolls it back.

## Migrating

```
npm run db:migrate              # migrate the JSON file into SQLite
npm run db:migrate -- --verify-only   # check an existing database, read-only
```

The migration is deliberately conservative:

1. The source JSON file is never modified, moved or deleted.
2. A timestamped backup (`wicksentinel.json.backup-<timestamp>`) is written
   first.
3. Every write happens inside one SQLite transaction, so a failure part-way
   leaves no partial database.
4. Afterwards, record counts and key relationships are re-read from the
   database and compared against the source. Any mismatch exits non-zero.
5. It refuses to run if `wicksentinel.db` already exists, because re-running
   would duplicate append-only audit records.

Run it with the server stopped. The migration takes the data-directory lock, so
it will refuse to run while the server holds it, and the server will refuse to
start while it runs.

## Verifying

`--verify-only` re-opens the database and checks relationships plus audit-log id
uniqueness. It never writes. Use it after a migration and after any restore.

## Rolling back

Rollback needs no restore step: the JSON file was never touched.

1. Stop the server.
2. Start it with `STORAGE_ENGINE=json` (or delete `wicksentinel.db`).

Caveat: rollback returns the deployment to the state captured in the JSON file.
Writes made while running on SQLite — new sessions, audit records, admin
changes — exist only in the database and are not replayed into JSON. If those
matters, export them before rolling back.

## Notes

- Both backends take the same exclusive lock (`wicksentinel.lock`), so only one
  process may write to a data directory regardless of engine.
- SQLite runs in WAL mode with `synchronous = NORMAL` and a 5s busy timeout.
- Keyed collections store the record as a JSON document with the key as a real
  primary key. Fields the store looks up by (`derivSub`, `userId`, `tokenHash`)
  are promoted to indexed generated columns. This keeps the TypeScript record
  types as the single source of truth while lookups stay indexed.
