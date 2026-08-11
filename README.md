# Finance dashboard

A single-user personal finance dashboard. Reads one Chase checking account
through [Teller](https://teller.io), caches everything in SQLite, and renders one
mobile-first page: the Friday allowance, available balance, upcoming charges,
monthly commitments, spending split, and recent transactions.

Node + TypeScript + Express, server-rendered HTML, vanilla JS. No React, no
bundler, no external database.

---

## Build status

| Step | State |
|---|---|
| 1. Scaffold, auth, deployable shell | **Done** |
| 2. Teller mTLS client, Connect enrollment, sync + cron | **Done** |
| 3. Classification rules and Friday paycheck engine | **Done** |
| 4. Dashboard UI and manual overrides | Not started |
| 5. PWA (manifest, service worker, icons) | Not started |
| 6. Chase statement import CLI | Not started |
| 7. Failure-mode notes | Not started |

Anything below marked _(step N)_ describes setup you only need when that step
lands.

---

## Requirements

- Node 22 or newer (developed on 24)
- A Teller account — free developer tier, 100 live connections
- A Railway account — the $5 Hobby plan is enough
- `poppler` for the statement importer _(step 6)_: `brew install poppler`

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
generated **once** — rotating it makes the stored Teller token undecryptable and
forces a bank re-link.

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
| `ENCRYPTION_KEY` | yes | Base64 32 bytes. Encrypts the Teller token at rest |
| `TELLER_APPLICATION_ID` | step 2 | From the Teller dashboard. Not a secret — it reaches the browser |
| `TELLER_ENVIRONMENT` | step 2 | `sandbox`, `development`, or `production` |
| `TELLER_CERT_B64` | step 2 | Base64 of your Teller client certificate |
| `TELLER_KEY_B64` | step 2 | Base64 of your Teller private key |
| `TELLER_API_BASE` | — | Defaults to `https://api.teller.io` |
| `SYNC_ENABLED` | — | Set `false` to boot without the scheduler |

A missing Teller variable does **not** stop the app booting. It disables syncing
and says so on the dashboard, so a half-configured deploy explains itself
instead of failing at the first API call. A missing `APP_PASSWORD_HASH` or
`ENCRYPTION_KEY` **does** stop the boot, with the reason printed.

---

## Teller setup _(step 2)_

Teller authenticates your **server** with a mutual-TLS client certificate, and
authenticates the **bank connection** with an access token you get once, through
Teller Connect. Two different things — you need both.

### 1. Create the application

Sign in at [teller.io](https://teller.io) and create an application. Copy the
application ID into `TELLER_APPLICATION_ID`.

Chase is supported: it appears on Teller's live institution list as `chase`,
with the `balance` and `transactions` products this app uses. You can confirm
that yourself at any time:

```bash
curl -s https://api.teller.io/institutions | grep -o '"name":"Chase"'
```

### 2. Generate the client certificate

In the Teller dashboard, under your application's certificates, generate a new
certificate. You get two files:

- `certificate.pem` — the client certificate
- `private_key.pem` — the private key, shown **once**

Download both. Keep them out of the repo (`certs/` is gitignored).

### 3. Base64-encode them for Railway

Environment variables cannot hold literal newlines, so both files are stored
base64-encoded on one line:

```bash
base64 -i certificate.pem | tr -d '\n'
```

```bash
base64 -i private_key.pem | tr -d '\n'
```

Put the first in `TELLER_CERT_B64`, the second in `TELLER_KEY_B64`. The app
decodes them in memory at startup and never writes them to disk.

### 4. Free tier

The developer tier covers 100 live connections at no cost, which is 99 more than
this app needs. `TELLER_ENVIRONMENT=development` reaches real banks on that tier.
`sandbox` returns fake data and needs no certificate — useful for testing.

---

## Railway deploy

1. **Create the service.** New project → Deploy from GitHub repo → pick this
   repo. Railway detects Node and runs `npm ci && npm run build`, then `npm start`
   (see [`railway.json`](railway.json)).

2. **Add a volume.** This is the part that is easy to miss: without it, SQLite
   lives on ephemeral disk and every deploy wipes your transaction history.
   In the service, go to Variables → Volumes → add one with mount path `/data`.

3. **Set the variables.** At minimum `NODE_ENV=production`,
   `DB_PATH=/data/finance.db`, `APP_PASSWORD_HASH`, and `ENCRYPTION_KEY`, plus
   the Teller values once step 2 lands. Paste the password hash unquoted —
   Railway's variable editor does not expand `$`.

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

## Security notes

- The Teller access token is encrypted with AES-256-GCM before it touches
  SQLite, and is only ever read server-side. It is never rendered into a page,
  returned by an endpoint, or logged. All Teller **API calls** happen on the
  server.

- **One unavoidable exception, by Teller's design:** Teller Connect hands the
  access token to the *browser* in its `onSuccess` callback. There is no
  server-side exchange step — unlike Plaid, Teller has no "public token" you
  swap for a real one. So at enrollment, and only then, the token exists in the
  page's JavaScript for a moment before being POSTed to the server over HTTPS
  and encrypted at rest. It is never sent back to the browser afterwards.

  Two things limit this. First, Teller's own documentation states that "access
  tokens are useless without a client certificate belonging to the application
  the user consented giving access to" — the mTLS certificate never leaves the
  server, so a leaked token alone cannot read your accounts. Second, enrollment
  is guarded by a single-use, 15-minute, server-generated `nonce`, so a token
  captured elsewhere cannot be replayed into this app's storage.
- The session cookie is `httpOnly`, `SameSite=Lax`, `Secure` in production, and
  holds a random 256-bit token. Only the SHA-256 of that token is stored, so a
  database leak does not hand over a live session.
- The login route is rate limited to 5 attempts per 15 minutes per IP. A correct
  password is also refused while the limit is active.
- Content-Security-Policy is `default-src 'self'` with no inline scripts or
  styles. The only external origin allowed is `cdn.teller.io`, for Teller
  Connect.
- `certs/`, `data/`, `.env` and `statements/` are gitignored.
