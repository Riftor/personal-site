# Backing up D1, and putting it back

_Plan task 8.3. Written 2026-08-13 against wrangler 4.120.0._

Read the first section before deciding you need any of this. **Most of what looks like "I need a
backup" is covered by something faster that is already switched on.**

---

## What is already covered, and what this is for

D1 has **Time Travel**: every database can be restored to any point in the recent past with one
command, with no backup to find and no file to download. Cloudflare's retention is **30 days on
the Workers Paid plan and 7 days on the Workers Free plan** — this site is on the Free plan, so
**7 days**.

So Time Travel covers the ordinary accidents:

- a `DELETE` without a `WHERE`
- a publish that overwrote an entry
- a migration that did the wrong thing
- "it was fine yesterday"

Time Travel does **not** cover, and this is the entire reason the export below exists:

- **The database being deleted.** Time Travel restores a database; it cannot restore one that is
  not there.
- **Losing the Cloudflare account** — billing dispute, a lockout, a suspension. Everything inside
  the account goes with it, Time Travel included.
- **Having a copy anywhere else.** Every recovery path Cloudflare offers begins with "log in to
  Cloudflare". A `.sql` file in a bucket you control is the only artefact here that could rebuild
  this site somewhere that is not Cloudflare.
- **Anything older than 7 days.**

**Reach for Time Travel first.** It is faster, it is in place, and it needs nothing to have been
set up in advance. The export is the thing you want on the day Time Travel is not an option.

---

## What the dump contains — treat it as the crown jewels

A dump is the **most sensitive artefact this system produces**. It is a complete copy of:

- `access_grant` — every approved email address and the tier it holds
- `session` — **live session tokens**. Anyone holding this file holds working credentials for
  everyone who was signed in when it was taken, until those rows are invalidated.
- `audit_log` — who signed in, when, and from which /24
- `content_entry` — the full text of every private memory

It is not media (those bytes are in R2 and the dump holds only keys), and it is not any Google
credential — the service-account key is a Wrangler secret and was never in D1.

Two consequences that are wired into the script rather than left to discipline:

1. **The dump goes to a separate bucket, `personal-site-backups`, and the Worker has no binding
   to it.** Not a prefix inside `personal-site-media` — a different bucket, absent from
   `wrangler.toml` entirely. The media bucket _is_ bound, so a bug in `/m/[assetId]/[variant]`
   could in principle stream a key from it. There is no code path in the deployed Worker that can
   reach a backup, by construction rather than by argument. Same reasoning as invariant 2 in
   `HANDOFF.md`.
2. **The dump never touches the working tree.** It is written to a `mkdtemp` directory outside the
   repository, uploaded, and deleted in a `finally`. `assertOutsideRepo` refuses the path if it
   ever points inside. A dump under the tree could be committed to a public repo, and — worse,
   because it needs nobody to make a mistake — swept into `.svelte-kit/cloudflare/` as a static
   asset, which Cloudflare serves _before_ the Worker runs.

If a dump does leak, `SECURITY.md` has the response. The short version: rotate
`BETTER_AUTH_SECRET`, which invalidates every session it carries.

---

## Setting it up

**One prerequisite, and it is yours to run** — the script will fail until the bucket exists:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
cd /home/caden/workspace/code/personal-site
npx wrangler r2 bucket create personal-site-backups
```

Do **not** add it to `wrangler.toml`, and do **not** give it a public `r2.dev` URL or a custom
domain. The CLI addresses it by name; nothing else should be able to address it at all.

Then:

```bash
pnpm backup --remote          # the real thing
pnpm backup                   # local D1 into local R2 — a rehearsal, not a backup
pnpm backup --remote --dry-run    # say what it would upload and delete, write nothing
```

Without `--remote` it backs up the **local simulated database** in `.wrangler/state`, exactly like
every other script in this repo, and says so loudly on the way out. That is useful for checking
the plumbing and useless as a backup.

### Running it nightly

`d1 export` is a CLI operation. There is **no binding for it**, so a Worker Cron Trigger cannot do
this however it is written — `scheduled()` has no way to reach the control plane. It runs on a
machine with wrangler logged in.

```cron
# crontab -e — 03:15 daily
15 3 * * * export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; cd /home/caden/workspace/code/personal-site && pnpm backup --remote >> "$HOME/.local/state/personal-site-backup.log" 2>&1
```

Check the log occasionally. A backup that has been silently failing for a month is worse than no
backup, because you think you have one.

**A GitHub Actions workflow was the obvious alternative and is deliberately not used.** This
repository is public. Running the backup in CI would mean minting a Cloudflare API token with D1
read and R2 write scope and storing it in a public repository's secrets — a new credential, held
by a third party, valid against production, forever, in exchange for not having to run a nightly
command on a machine that is already logged in. That is a bad trade for a convenience. If the
laptop is the wrong place for this, the next option is a small always-on box you control, not CI.

### Retention

The newest **14** backups are kept and the rest are deleted (`--keep <n>` to change it). wrangler
has no "list objects" command, so the script keeps a `manifest.json` in the bucket and prunes from
that. Two rules make the pruning safe to leave unattended:

- **Anything the script does not recognise is never deleted.** A key has to match the exact
  `d1/personal-site-<instant>.sql` shape to be eligible. Another object in the bucket is not this
  script's to remove, and it does not consume the retention budget either.
- **A manifest it cannot read is an error, not an empty list.** Reading a corrupt manifest as
  empty would prune nothing and then write a manifest that had forgotten every object already
  there — every previous backup orphaned, silently, while the run reported success.

`scripts/backup/retention.spec.mjs` holds the boundary cases, including both directions of the
off-by-one at exactly `keep` backups.

---

## Restoring

### First: which path are you on?

| What happened                                                | Use                                      |
| ------------------------------------------------------------ | ---------------------------------------- |
| Bad write, bad migration, deleted rows — **within 7 days**   | **Time Travel.** In place, one command.  |
| The database was deleted, or the damage is older than 7 days | **A dump.** Rebuild into a new database. |
| The Cloudflare account is gone                               | A dump, into whatever you rebuild onto.  |

### Path A — Time Travel (fast, in place)

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
cd /home/caden/workspace/code/personal-site

# 1. Find the bookmark for the moment you want. Timestamps are UTC, RFC3339 or Unix seconds.
npx wrangler d1 time-travel info personal-site --timestamp "2026-08-13T02:00:00Z"

# 2. Restore. This rewrites the live database in place — read step 3 before running it.
npx wrangler d1 time-travel restore personal-site --timestamp "2026-08-13T02:00:00Z"

# 3. Check what you got before trusting it.
npx wrangler d1 execute personal-site --remote --command \
  "select count(*) from access_grant where revoked_at is null"
```

Then **do the post-restore steps below** — they apply to Time Travel exactly as much as to a dump.
Going back in time restores revoked grants and dead sessions just as surely as an old file does.

### Path B — from a dump (for a database that is gone)

**Nothing here overwrites the damaged database.** The restore goes into a _new_ one, gets checked,
and only then does the site get pointed at it. If the restore turns out to be the wrong night's,
you have lost nothing.

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
cd /home/caden/workspace/code/personal-site
```

**1. Find the backup you want.** The manifest lists them newest first:

```bash
npx wrangler r2 object get personal-site-backups/manifest.json --file /tmp/manifest.json --remote
cat /tmp/manifest.json
```

**2. Download it.** Use the full key from the manifest:

```bash
npx wrangler r2 object get \
  personal-site-backups/d1/personal-site-2026-08-13T03-15-02Z.sql \
  --file /tmp/restore.sql --remote
```

**Do not put it in the repository, and delete it when you are finished** (`shred -u /tmp/restore.sql`,
or `rm` if shred is not there). It carries live session tokens. Everything below assumes `/tmp`.

**3. Sanity-check the file before you trust it.** Thirty seconds, and it catches a truncated or
empty download:

```bash
head -1 /tmp/restore.sql                  # expect: PRAGMA defer_foreign_keys=TRUE;
grep -c '^CREATE TABLE' /tmp/restore.sql  # expect: 9 or so — every table
grep -c '^INSERT INTO "access_grant"' /tmp/restore.sql   # expect: however many people have access
```

**4. Create a new database and restore into it:**

```bash
npx wrangler d1 create personal-site-restored
# It prints a database_id. Keep the terminal open; you need it in step 6.

npx wrangler d1 execute personal-site-restored --remote --file /tmp/restore.sql
# expect: "🚣 N commands executed successfully." and no ERROR line.
```

`--file`, not `--command`. `--file` returns a batch summary rather than rows on `--remote`, which
broke the access CLI once (see `HANDOFF.md`) — here nothing reads the result, and the dump is far
too large for a command line, so `--file` is correct. Do not "fix" it.

**5. Check it before switching anything over:**

```bash
npx wrangler d1 execute personal-site-restored --remote --command \
  "select (select count(*) from access_grant) grants, (select count(*) from content_entry) entries,
          (select count(*) from media_asset) assets, (select count(*) from session) sessions"
```

Grants and entries should look like the site you remember. If `grants` is 0, you restored an empty
file — stop and go back to step 2.

**6. Point the site at it.** Put the new `database_id` from step 4 into `wrangler.toml` (the
`database_name` can stay as it is; the id is what binds), then:

```bash
pnpm build && npx wrangler deploy
```

**7. Now do the post-restore steps.** They are not optional.

**8. Once the site is confirmed working**, delete the dump and, when you are sure, the old
database:

```bash
shred -u /tmp/restore.sql
npx wrangler d1 delete personal-site        # only when you are certain
```

---

## After **any** restore — the part that is easy to skip

A restore is a time machine, and it carries back things you had deliberately thrown away. Both of
these are silent: the site will look completely normal while being wrong.

### 1. Clear `session` — old tokens become valid again

Every `session` row in the dump is a working credential. Restoring the file makes tokens that were
revoked, expired, or deleted in an incident **live again**. If the reason you are restoring is that
something leaked, this hands the credentials straight back.

```bash
npx wrangler d1 execute personal-site --remote --command "DELETE FROM session"
```

Everyone signs in again with Google. That is the entire cost, and it takes them one click. Do it
every time, without weighing it up.

### 2. Re-check `access_grant` — revoked people are back

`access:revoke` is a soft revoke: it sets `revoked_at`. A dump from before the revocation has that
column as `NULL`, so **anyone whose access you removed after the backup was taken has it back**,
at the tier they used to hold. Nothing warns you. There is no error. They simply work again.

```bash
pnpm access:list --remote
```

Read every row. For anyone who should not be there:

```bash
pnpm access:revoke someone@example.com --remote
```

The same applies in the other direction, and matters much less: someone granted access _after_ the
backup was taken has lost it, and re-granting is one command.

### 3. Check the tier table survived

```bash
npx wrangler d1 execute personal-site --remote --command \
  "select slug, rank, calendar_detail, calendar_horizon_days from tier order by rank"
```

Expect exactly five rows: `public` 0, `friend` 10, `family` 20, `partner` 30, `owner` 100. This is
the AUTHORITATIVE seed in plan §3. `calendar_detail` and `calendar_horizon_days` are read live from
this table, so a wrong row here changes what a real person can see.

---

## Notes for whoever is doing this at 3am

**The single-file `wrangler d1 export` does not restore, and the script works around it.** Left to
itself, `d1 export` interleaves each table's `CREATE` with its `INSERT`s in an order that puts
`INSERT INTO "session"` before `CREATE TABLE "user"`, which `session.user_id` references. It opens
the file with `PRAGMA defer_foreign_keys=TRUE` to cover that, but the pragma is scoped to a
transaction and does not survive the file being split into statements — so feeding wrangler's own
export straight back to `wrangler d1 execute --file` fails on the first `session` row with
`no such table: main.user`. The backup script therefore runs two exports, `--no-data` then
`--no-schema`, and uploads them joined: all the `CREATE`s, then all the `INSERT`s. **A dump written
by `pnpm backup` restores in one command; a dump you take by hand with a bare `d1 export` will
not.** If you are ever restoring a hand-taken export and see `no such table`, this is why.

**Restoring into a database that already has the tables fails**, with `table … already exists`, and
that is a feature — it is why step 4 creates a new database. A dump cannot silently half-merge into
a live one.

**If you are restoring into plain SQLite rather than D1** — an exit from Cloudflare, or a local
forensic look at what a dump contains — turn foreign keys off first, or the `session` rows fail
against `user` rows that come later in the file:

```bash
sqlite3 restored.db "PRAGMA foreign_keys=OFF;" ".read /tmp/restore.sql"
```

D1 does not need this. A stricter client does.

**Verified 2026-08-13, against local D1 and local R2**: a `pnpm backup` dump was uploaded,
downloaded again, and restored into an empty database — 310 statements, no errors, and **every
table's row count identical to the source** (users, sessions, grants, tiers, entries, media assets
and variants, audit log). Retention was exercised across five runs at `--keep 2` and pruned exactly
the oldest each time. The failing single-file case above was reproduced first, so the workaround is
answering a real error rather than a suspected one.

**What has never been run against production**: the `--remote` path, in either direction. The live
site is not a test fixture, `personal-site-backups` does not exist yet, and a `--remote` restore
would write to the real database. The commands are identical bar the flag, but that is an argument,
not evidence. **The first `pnpm backup --remote` is the real test** — run it by hand, watch the
output, and check the object landed before trusting the cron entry.
