# Finance dashboard

A single-user personal finance dashboard. Reads one Chase checking account
through [SimpleFIN](https://www.simplefin.org), caches everything in SQLite, and renders one
mobile-first page: the Friday allowance, available balance, upcoming charges,
monthly commitments, spending split, and recent transactions.

Node + TypeScript + Express, server-rendered HTML, vanilla JS. No React, no
bundler, no external database.

---

## Build status

| Step | State |
|---|---|
| 1. Scaffold, auth, deployable shell | **Done** |
| 2. SimpleFIN client, token claim, sync + cron | **Done** |
| 3. Classification rules and Friday paycheck engine | **Done** |
| 4. Dashboard UI and manual overrides | **Done** |
| 5. PWA (manifest, service worker, icons) | **Done** |
| 6. Chase statement import CLI | **Done** |
| 7. Failure-mode notes | **Done** |

---

## Requirements

- Node 22 or newer (developed on 24)
- A SimpleFIN Bridge subscription — $15/year
- A Railway account — the $5 Hobby plan is enough
- `poppler` for the statement importer: `brew install poppler`

---

## Local setup

```bash
npm install
npm run build
```

Create the two secrets:

```bash
npm run hash-password
```

```bash
node dist/scripts/generate-key.js
```

Copy `.env.example` to `.env` and paste both values in. `ENCRYPTION_KEY` is
generated **once** — rotating it makes the stored SimpleFIN credential
undecryptable and forces a reconnect.

Then:

```bash
npm start
```

The dashboard is at http://localhost:3000. Every route except `/login`,
`/healthz` and the static assets requires a session.

Useful commands:

```bash
npm run typecheck
```

```bash
npm test
```

---

## Environment variables

Every variable is documented inline in [`.env.example`](.env.example). Summary:

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes | `production` enables HTTPS redirects, HSTS, and the `Secure` cookie flag |
| `PORT` | — | Railway injects this automatically |
| `DB_PATH` | on Railway | SQLite location. Set to `/data/finance.db` with a volume mounted at `/data` |
| `APP_TIMEZONE` | — | Defaults to `America/Chicago`. Drives pay weeks and cron times |
| `APP_PASSWORD_HASH` | yes | argon2id hash from `npm run hash-password` |
| `SESSION_DAYS` | — | Session cookie lifetime, default 30 |
| `LOGIN_MAX_ATTEMPTS` | — | Login rate limit, default 5 |
| `LOGIN_WINDOW_MINUTES` | — | Rate limit window, default 15 |
| `ENCRYPTION_KEY` | yes | Base64 32 bytes. Encrypts the SimpleFIN access URL at rest |
| `SIMPLEFIN_BRIDGE_URL` | — | Where the "get a token" link points. Defaults to the Bridge |
| `SYNC_ENABLED` | — | Set `false` to boot without the scheduler |

SimpleFIN needs no environment credentials at all — the access URL lives
encrypted in the database, not in the environment. A missing
`APP_PASSWORD_HASH` or `ENCRYPTION_KEY` stops the boot, with the reason
printed.

---

## SimpleFIN setup

Teller, the original provider, withdrew its API in July 2026. This app uses
[SimpleFIN Bridge](https://beta-bridge.simplefin.org) instead: $15/year or
$1.50/month, covering up to 25 institutions.

There is **no certificate, no private key, and no API key in the environment**.
The whole connection is one pasted token:

1. **Subscribe and connect your bank.** Sign in at SimpleFIN Bridge, add Chase,
   and complete their bank login. Chase Bank is on their supported list.

2. **Create a setup token.** On the Bridge site, generate a new setup token and
   copy it. It is a long base64 string.

3. **Paste it into the app.** Open `/connect` on your deployed dashboard and
   paste the token. The server base64-decodes it, POSTs once to the claim URL
   inside it, and receives an **access URL** containing HTTP Basic credentials.
   That access URL is encrypted with AES-256-GCM and stored in SQLite.

The setup token is **single use** — it stops working the moment it is claimed.
If you need to reconnect later, generate a fresh one. Pasting a new token
replaces the stored credential and keeps all existing transaction history.

### Limits worth knowing

- **Roughly 24 requests per day.** The twice-daily sync uses one request each;
  a first-run backfill uses four. Comfortably inside the quota.
- **90 days maximum per request.** The first sync therefore walks back a year
  in four 90-day windows. How much history actually comes back varies by
  institution, which is why the statement importer still matters.
- **`pending=1` is mandatory.** SimpleFIN omits pending transactions unless
  asked. The client always sends it; a test asserts this, because forgetting it
  would silently make the dashboard three to four days stale.
- **Errors can arrive with HTTP 200.** A broken bank link is reported in the
  response's `errlist`, not the status code, so a "successful" response is not
  on its own proof the data is current. Those warnings are surfaced.

## Railway deploy

1. **Create the service.** New project → Deploy from GitHub repo → pick this
   repo. Railway detects Node and runs `npm ci && npm run build`, then `npm start`
   (see [`railway.json`](railway.json)).

2. **Add a volume.** This is the part that is easy to miss: without it, SQLite
   lives on ephemeral disk and every deploy wipes your transaction history.
   In the service, go to Variables → Volumes → add one with mount path `/data`.

3. **Set the variables.** At minimum `NODE_ENV=production`,
   `DB_PATH=/data/finance.db`, `APP_PASSWORD_HASH`, `ENCRYPTION_KEY` and
   `APP_TIMEZONE=America/Chicago`. There are no provider credentials to set —
   SimpleFIN is connected by pasting a token at `/connect` after deploying.
   Paste the password hash unquoted; Railway's variable editor does not
   expand `$`.

4. **Generate a domain.** Settings → Networking → Generate Domain. Railway
   terminates TLS for you; the app trusts one proxy hop and redirects any plain
   HTTP request to HTTPS.

5. **Check the health endpoint.** `https://<your-domain>/healthz` returns `ok`.
   Railway is configured to use it as the healthcheck path.

Keep `numReplicas` at 1. SQLite on a single volume assumes one writer, and the
sync scheduler assumes it is the only one running.

---

## Syncing

Balances and transactions are pulled twice a day, at **7:00 and 19:00
America/Chicago**, by a scheduler inside the service (no external cron). The
dashboard also has a **Sync now** button, which starts a background sync and
polls until it finishes.

Details worth knowing:

- **Pending transactions are first class.** They are stored with
  `status = 'pending'`, tagged in the UI, and counted in spending. The headline
  balance is the **available** balance, which is already net of pending
  activity; the posted balance is shown underneath with the difference labelled
  "still pending".
- **Settlement is reconciled.** When a pending charge posts, some institutions
  keep the transaction id and some issue a new one. Both are handled: same-id
  settlement updates in place, and a new id is matched back to the pending row
  by amount, a ±5 day window, and description similarity. The pending row is
  then removed and the posted row records `settled_from`. Without this, every
  settling charge would double-count.
- **Manual reclassifications follow the charge** across a settlement id change.
- **A pending charge that the bank stops reporting** is kept for 14 days, then
  dropped as an abandoned authorisation. Leaving it would inflate spending
  forever.
- **First sync backfills** as much history as the institution exposes, paging
  backward. Later syncs only pull the recent window.
- **A failed sync never destroys cached data.** The dashboard keeps showing the
  last good numbers, with the sync timestamp turning red and an explicit
  "not current" warning.
- **Disconnection is distinguished from an outage.** A revoked token or an
  `enrollment.disconnected.*` error puts the dashboard into a "reconnect your
  bank" state. A 502 from the institution does not — it is a transient failure
  and is retried with backoff.

---

## Classification and the Friday paycheck

All rules live in [`config/rules.json`](config/rules.json) — subscriptions,
essentials, bill patterns, exclusions, income channels, and the allowance rate.
Edit that file to change behaviour; no logic is hardcoded. Classification is
fully deterministic: the same transaction always lands in the same place, and
there are no LLM calls or learned models anywhere in the pipeline.

**Precedence**, highest first:

1. **Manual override** — beats everything, and survives re-syncs.
2. **Essentials** — deliberately ahead of exclusions. The $280 debt repayment is
   a Zelle to myself, which the self-transfer exclusion would otherwise swallow.
   It is a real commitment, not money moving.
3. **Exclusions** — Dave advances and repayments, credit card payments, and
   transfers between my own accounts. Neither income nor spending.
4. **Subscriptions** — merchant pattern *and* amount within tolerance, so an
   ordinary Amazon order is not mistaken for the $8.67 membership. Railway is
   marked `variableAmount` because it bills a base plus usage.
5. **Bill patterns** — gas, Affirm, anything matching `insurance`.
6. **Income** — only the listed channels count.
7. Everything else outgoing is **discretionary**.

**Split charges.** Claude Max sometimes posts as two charges in one cycle
(e.g. $21.95 + $88.30). Neither half is near $109.75, so the per-transaction
amount check rejects both. A second pass tests the *combined* total of
same-merchant charges inside the grouping window. It is opt-in per subscription
(`allowSplit`), because enabling it on Amazon would let two unrelated purchases
summing to $8.67 look like the membership.

**Credits are not automatically income.** A credit counts as income only if it
matches a listed income channel. Otherwise it is treated as a possible refund
and only reduces spending if it can be traced to an earlier discretionary charge
from the same merchant, capped at that charge's value. An untraceable credit is
left out of the maths entirely and surfaced for review — crediting it would cut
spending by its full value and inflate the allowance by the same amount, which
is a worse error than ignoring it.

**Refund timing.** A refund that lands in a later week than the purchase is
attributed back to the purchase's week, so a return never leaves a past week
permanently short.

**The allowance** is `rate x real income that week - discretionary already
spent`, over a pay week running Friday to Thursday and paid the following
Friday. On Friday itself the figure shown is the week that ended the day
before. Pending charges count, and are flagged when they are moving the number.
The result can be negative, and a negative number is real: the money was already
spent out of the account, so the shortfall carries.

---

## Using the dashboard

One page, top to bottom:

1. **Friday paycheck** — the number the app exists for, with the arithmetic
   spelled out beneath it and the days until Friday. Green when there is
   something to pay yourself, red when there is not. Expand "Previous 4 weeks"
   to compare.
2. **Available to spend** — the available balance leads, the posted balance sits
   underneath, and the difference is labelled "still pending".
3. **Next up** — the soonest projected charge.
4. **Monthly commitments** — essentials first and marked, subscriptions below,
   each with what it costs per month, when it last landed, and when it is next
   expected. Essentials carry an explicit *paid this month* or *not paid yet*,
   because those have no fixed billing date and are the ones that get missed.
5. **Last 30 days** — one total split into subs-and-bills versus everything
   else, with per-category rows under each.
6. **Recent transactions** — every row shows its classification. Tap one to see
   which rule decided it, the raw bank description, and four buttons to
   reclassify it as bill, fun, income, or ignored.

**Correcting a classification** takes one tap. The override is stored
separately from the transaction, so a re-sync never overwrites it, and it
follows the charge if the bank re-issues it under a new id when it settles. A
corrected row is tagged *Manual*, and "Clear" puts it back under the rules.

**Add to Home Screen** installs it: standalone, no browser chrome, real icon.
It caches the last dashboard you loaded, so opening it with no signal shows
that page immediately behind a banner naming when the snapshot was taken.
Signing out deletes the cached copy.

---

## Importing statements

```bash
brew install poppler
```

Put the PDFs somewhere outside the repo (`statements/` is gitignored), then:

```bash
npm run build && node dist/scripts/import-statements.js ./statements --dry-run
```

That prints what each file yields without writing anything. When it looks
right, load it into the deployed app:

```bash
node dist/scripts/import-statements.js ./statements --url https://your-app.up.railway.app
```

It asks for your dashboard password (or reads `DASHBOARD_PASSWORD`), parses
locally, and posts the rows. Drop `--url` to write to a local database instead.

Running it twice is safe. Rows are matched against everything already stored by
date, amount and description similarity, so re-importing the same statement
inserts nothing, and a charge that also arrives through SimpleFIN replaces the
imported copy rather than double-counting.

`--show-skipped` prints lines that looked like transactions but were not
parsed, which is the first thing to check if a total looks wrong.

---

## What breaks first, and how you would notice

Ordered by how likely it is to actually happen.

**The SimpleFIN subscription lapses.** $15/year, and if it expires the API
returns `402` and stops returning data. The dashboard says *SimpleFIN
subscription lapsed* and states plainly that this is a billing problem rather
than a bank problem. Balances stay visible but greyed, and the sync timestamp
turns red. Fix: renew, then paste a fresh setup token at `/connect`.

**Chase makes you re-authenticate.** Banks periodically invalidate a
connection, often after a password change or an MFA prompt. SimpleFIN reports
this in the response's `errlist` *with an HTTP 200*, so a successful response is
not proof the data is current — those warnings are surfaced and put the
dashboard into a "reconnect" state. Fix: new setup token at `/connect`. Your
history is kept.

**The scheduler stops.** The cron lives inside the service, so if the process
dies and Railway restarts it, the schedule restarts too and at most one sync is
missed. If it stops firing entirely, the dashboard shows *Sync is overdue* once
the last successful sync is more than 14 hours old, and the header timestamp
turns red. Fix: hit **Sync now**; if that works, the scheduler is the problem,
not the connection.

**The volume is missing or the mount path changes.** This is the quiet one.
Without `DB_PATH=/data/finance.db` and a volume at `/data`, SQLite writes to the
container's ephemeral disk, and every deploy silently starts from an empty
database. Nothing errors. You would notice the transaction count resetting and
the commitments all reading *never seen*. Check the volume before assuming
anything else is wrong.

**A classification rule stops matching.** Chase occasionally rewords a
description, and a subscription then reads as discretionary — which quietly
inflates your fun-money spending and shrinks the allowance. You would notice a
commitment showing *Not paid yet* when you know you paid it, or a familiar
merchant tagged **Fun** in Recent transactions. Fix: correct it inline, or edit
`config/rules.json` if it will keep happening. Every row shows which rule fired,
so this is visible rather than mysterious.

**SimpleFIN changes their API or shuts down.** Teller did exactly this in July
2026, mid-build. The provider is one module (`src/simplefin.ts`) behind a small
interface; the sync engine, classification, paycheck maths and UI are provider
agnostic. A replacement is roughly a day of work, not a rewrite.

**You hit the request quota.** Roughly 24 requests a day. Two scheduled syncs
plus a first-run backfill of four is well inside it, but hammering **Sync now**
could reach it. SimpleFIN reports it as a warning; repeated abuse can disable
the token.

**The encryption key changes.** Rotating `ENCRYPTION_KEY` makes the stored
SimpleFIN credential undecryptable. The app treats that as disconnected rather
than crashing, so you get the reconnect prompt. Fix: paste a new setup token.

---

## Security notes

- The SimpleFIN access URL carries HTTP Basic credentials for the full account
  history. It is encrypted with AES-256-GCM before it touches SQLite and is only
  ever read server-side — never rendered into a page, returned by an endpoint,
  or logged. All SimpleFIN calls happen on the server.

- **The setup token is claimed server-side.** It arrives once in a form POST,
  is exchanged for the access URL by the server, and is never stored in raw
  form or echoed back into the page. Because SimpleFIN needs no browser SDK,
  no third-party script runs on any page of this app, and the credential never
  passes through client-side JavaScript. (Teller, the original provider,
  handed its access token to the browser; SimpleFIN's model avoids that
  entirely.)

- The session cookie is `httpOnly`, `SameSite=Lax`, `Secure` in production, and
  holds a random 256-bit token. Only the SHA-256 of that token is stored, so a
  database leak does not hand over a live session.
- The login route is rate limited to 5 attempts per 15 minutes per IP. A correct
  password is also refused while the limit is active.
- Content-Security-Policy is `default-src 'self'` with no inline scripts or
  styles, `frame-src 'none'`, and no external origins allowed at all.
- The service worker caches the rendered dashboard so it works offline, which
  means balances live in Cache Storage. Signing out deletes that cache, and
  nothing under `/api/` is ever cached.
- `data/`, `.env` and `statements/` are gitignored.
