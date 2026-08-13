# Security

This is a personal site. Its public half is a portfolio anyone can read; its private half is gated
by Google sign-in, with each approved address assigned a tier and every page, API response and
media byte checked server-side on every request.

## Reporting a vulnerability

Email **cadenedam@gmail.com** with `security` in the subject. Please include what you did, what you
got back, and the URL. I will confirm receipt.

If you found a way to read private content without an appropriate grant — a private page, a photo,
a calendar event — that is the thing this site exists to prevent, and I would much rather hear
about it than not. Please do not post it publicly before I have had a chance to fix it, and please
do not enumerate or download other people's content to demonstrate it; one request that shows the
response code is enough.

There is no bounty. There is genuine gratitude.

---

## Emergency controls, in order of reach

| If you need to…                    | Do this                                              | Effect                          |
| ---------------------------------- | ---------------------------------------------------- | ------------------------------- |
| Sign **everybody** out immediately | Rotate `BETTER_AUTH_SECRET`                          | Every session, everywhere, dead |
| Cut off calendar access **now**    | Unshare the calendar from the service account        | Instant, no deploy              |
| Remove one person's access         | `pnpm access:revoke <email> --remote`                | Grant revoked, sessions deleted |
| Take the whole site down           | Disable the Worker route in the Cloudflare dashboard | Nothing serves                  |

Every command below assumes:

```bash
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"
cd /path/to/personal-site
```

Secrets are stored with `wrangler secret put`, which reads the value from stdin and stores it on
Cloudflare's side. Nothing secret is ever in `wrangler.toml`, which is committed to this public
repository. `wrangler secret list` prints names only, never values.

---

## `GOOGLE_SA_PRIVATE_KEY` — the calendar service account

This key lets the Worker read one Google Calendar, read-only. It grants nothing else: not Gmail,
not Drive, not the ability to write to the calendar, and no access to this site.

**There are two independent kill switches, and the first one is almost always the right one.**

### 1. Unshare the calendar — do this first

Google Calendar → the calendar's **Settings and sharing** → **Share with specific people or
groups** → remove the service account address.

This is the narrowest and fastest control available:

- **Instant.** No deploy, no build, no secret to rotate, no window where the site is down.
- **It works even if the key is still valid.** The key proves who the service account is; the share
  is what gives it anything to read. Take the share away and a stolen key opens nothing.
- **It breaks nothing else.** The calendar page degrades to its "calendar unavailable" state; every
  other part of the site is untouched.

Reach for this the moment you suspect the key is exposed. Rotating can happen calmly afterwards.

### 2. Delete the key — then issue a new one

Google Cloud console → **IAM & Admin → Service Accounts** → the calendar reader account →
**Keys** → delete the compromised key. A deleted key stops authenticating immediately.

Then:

```bash
# Create a new JSON key in the same console screen, then:
npx wrangler secret put GOOGLE_SA_PRIVATE_KEY
```

Paste the `private_key` value **with its literal `\n` sequences intact** — backslash-n as two
characters, all on one line, exactly as it appears in the JSON Google gives you. Do not paste a
real multi-line PEM; the code converts the escapes back before parsing it.

Then re-share the calendar with the service account (**See all event details**, read-only) if you
unshared it in step 1, and redeploy so the Worker picks up the new secret:

```bash
pnpm build && npx wrangler deploy
```

Confirm the calendar page renders events again before you consider this finished. The secret
existing is not the same as the secret parsing — `wrangler secret list` proves the former only.

**Why this design has two switches at all:** the alternative — a stored OAuth refresh token for the
owner's own account — would carry the owner's own calendar grant, so revoking it means revoking the
app's authorization on a personal Google account, and the token expires and needs re-authorizing on
a schedule anyway. A service account with a calendar share has a revocation path that touches
nothing else.

---

## `GOOGLE_CLIENT_SECRET` — visitor sign-in

The OAuth client secret used for "Continue with Google". It proves this application's identity to
Google during sign-in. On its own it cannot read anyone's data — the visitor flow requests only
`openid`, `email` and `profile`, and never a calendar scope.

**Rotate in this order and there is no outage**, because Google lets both secrets work at once:

```
1. Google Cloud console → Clients → the web client → add a NEW client secret.
   The old one keeps working. Sign-in is unaffected.

2. npx wrangler secret put GOOGLE_CLIENT_SECRET     # paste the new value

3. pnpm build && npx wrangler deploy

4. Sign in with a real account and confirm it works.

5. Only now: delete the old secret in the Google console.
```

The order is the whole point. Deleting first means every sign-in fails until the deploy in step 3
finishes. Adding first means the two overlap and nobody notices.

If the secret is known to be compromised rather than merely old, do steps 1–3 immediately and step
5 within the hour, accepting that anyone holding it could impersonate the application in the
meantime. `GOOGLE_CLIENT_ID` is not a secret and does not change.

---

## `BETTER_AUTH_SECRET` — the "sign everybody out" control

This secret signs and verifies session cookies. **Rotating it invalidates every session on the site
at once.** Everyone signed in is signed out and has to click "Continue with Google" again.

That is not a side effect to be worked around. It is the emergency control, and it is the right
response to any of these:

- the session store or a database dump has leaked
- a device with an active session was lost or stolen
- a session token appeared somewhere it should not have (a log, a screenshot, a shared URL)
- you simply want to be certain nobody is holding a credential you did not authorise

```bash
# Generate a new one — 32 random bytes, base64:
openssl rand -base64 32

npx wrangler secret put BETTER_AUTH_SECRET
pnpm build && npx wrangler deploy
```

Nothing else needs touching. Grants live in `access_grant` and survive this untouched, so everyone
who should have access gets it back the moment they sign in again. The cost is one click per
person.

There is nothing to clean up afterwards: existing `session` rows become unusable rather than
dangerous, and expire on their own. If you want them gone immediately:

```bash
npx wrangler d1 execute personal-site --remote --command "DELETE FROM session"
```

---

## A leaked database backup

The nightly D1 dump (see `docs/backup-and-restore.md`) is the most sensitive artefact this system
produces. If one is exposed — a laptop lost, a bucket misconfigured, a file emailed by mistake —
assume it contains all of this:

- **`session` — live session tokens.** Working credentials for everyone who was signed in when the
  dump was taken. This is the urgent part.
- **`access_grant`** — every approved email address and the tier it holds.
- **`audit_log`** — sign-ins and refusals, with truncated IP prefixes (/24 and /48 only; full
  addresses are never stored).
- **`content_entry`** — the full text of every private page and memory.

It does **not** contain media bytes (R2 keys only, and the bucket is reachable only through the
Worker), any Google credential, or any visitor's OAuth tokens — those are never persisted.

**Response, in order:**

1. **Rotate `BETTER_AUTH_SECRET`** (above). This kills every session token the dump carries, which
   is the only part of it that is a live credential rather than a disclosure. Do this first and do
   it before investigating anything.
2. **Review `access_grant`.** `pnpm access:list --remote`. The dump told whoever has it exactly who
   can see what; revoke anything that should not be there.
3. **Delete the exposed copy**, and any copy of it, everywhere it reached.
4. **Accept the disclosure.** The email addresses and the private text in that dump are out. There
   is no control that undoes it. Tell anyone whose information was in it — that is a courtesy the
   people in those memories are owed, not an optional step.

To reduce the chance of this: backups go to a bucket the Worker has **no binding to** and that is
absent from `wrangler.toml` entirely, dumps are written to a temp directory outside the repository
and deleted after upload, and only the newest 14 are retained.

---

## A grant given to the wrong person

Typo in an address, an address that turned out to belong to someone else, or a relationship that
changed:

```bash
pnpm access:revoke someone@example.com --remote
```

This does two things:

- Sets `revoked_at` on the grant. The tier is resolved from `access_grant` on **every request**,
  with no caching in the session or the cookie, so their next request is refused whatever they are
  holding.
- **Deletes their `session` rows**, so they are signed out rather than left browsing a page that
  worked a second ago. They can sign in with Google again — and will then be refused.

There is no residual access window. There are no presigned media URLs to expire (media is streamed
through an authorizing route, never a bearer URL), private media is `no-store` so nothing is cached
at the edge, and sessions are database rows rather than JWTs, so there is no token to wait out.

Confirm it:

```bash
pnpm access:list --remote     # they should read REVOKED
```

**The one thing revocation cannot undo:** anything they already downloaded is theirs permanently.
Worth internalising before publishing something you would be upset to lose control of.

---

## Things that are deliberately public

So that reading this repository is not mistaken for finding something:

- **`wrangler.toml` contains a D1 database id and bucket names.** These are identifiers, not
  credentials. They are useless without an authenticated Cloudflare session for the account.
- **The access-control logic is all here in the open**, including the route table and the tier
  ranks. It is meant to be reviewable. Nothing in this design relies on the rules being secret —
  only on the credentials being secret and the checks running server-side on every request.
- **There is no admin UI and no HTTP endpoint that can create or escalate a grant.** Grants are
  written only by a local CLI against the database. That is the highest-privilege operation in the
  system and it is not reachable from the internet at all.
