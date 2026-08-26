# Ledger MCP connector

A small [MCP](https://modelcontextprotocol.io) server that lets **Claude** read
and update your Ledger tracker. It reads and writes the **same Firestore
document the web app uses** (`ledger/main`), so anything Claude changes shows up
live in the app on every device, and vice-versa.

Pair it with Claude's built-in **Gmail** connector and you can say things like:

> "Read the email from the property manager and make a task for it."
> Claude drafts it, asks you for a due date, then adds it to your tracker.

---

## What it exposes

| Tool | What it does |
|------|--------------|
| `get_board` | Overview: categories, open tasks, active bills (call first for context) |
| `list_tasks` | List/filter tasks (open, overdue, today, this week, by status, by category) |
| `add_task` | Create a task (title, category, priority, due date, notes, checklist) |
| `update_task` | Change any field on a task (match by id or title) |
| `complete_task` | Mark a task done |
| `delete_task` | Delete a task |
| `list_bills` | List bills & income |
| `add_bill` | Add a bill or income (recurring, one-time, or custom cadence) |
| `pay_bill` | Log a payment/receipt and advance the due date |
| `add_grocery` | Add a shopping-list item (auto-filed into an aisle by the app) |

---

## 1. Get a Firebase service account key

The server writes to Firestore as a trusted backend, so it uses a service
account (this is separate from the app's PIN login).

1. Firebase console → your project (**ledger-app-732df**) → ⚙ **Project settings**.
2. **Service accounts** tab → **Generate new private key** → downloads a JSON file.
3. You'll paste the **entire contents** of that JSON into an environment
   variable named `FIREBASE_SERVICE_ACCOUNT` (as one line). Keep this secret —
   it grants full access to your database.

## 2. Pick a secret for the URL

The connector is protected by a secret that lives in the URL path. Generate one:

```bash
node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
```

Your connector URL will be `https://YOUR-HOST/<that-secret>/mcp`.

## 3. Run it

### Locally (test, or use with Claude Desktop only)

```bash
cd mcp-server
npm install
cp .env.example .env        # then edit .env: paste the secret + service account JSON
npm start                    # listens on http://localhost:8080
```

Smoke-test that tools load (no Firebase needed for this call):

```bash
curl -s http://localhost:8080/$LEDGER_MCP_SECRET/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
```

### Hosted (works from Claude on your phone too) — recommended

Any Node host works. **Render** (free tier) is simplest:

1. Push this repo to GitHub (already done).
2. Render → **New → Web Service** → connect the repo.
3. **Root Directory:** `mcp-server`  ·  **Build:** `npm install`  ·  **Start:** `npm start`.
4. **Environment** → add:
   - `LEDGER_MCP_SECRET` = the secret from step 2
   - `FIREBASE_SERVICE_ACCOUNT` = the full JSON from step 1 (one line)
5. Deploy. Your URL is `https://<your-app>.onrender.com/<secret>/mcp`.

(Railway, Fly.io, Cloud Run, or a small VPS work the same way — set the two env
vars, start `npm start`.)

## 4. Connect it in Claude

On **claude.ai** (web/mobile) or **Claude Desktop**:

1. **Settings → Connectors → Add custom connector**.
2. Name: `Ledger`. URL: `https://<your-app>.onrender.com/<secret>/mcp`.
3. Save. Claude connects and lists the tools above.
4. Also enable the **Google / Gmail** connector so Claude can read email.

Now, on any device: *"Claude, from that email make a task, due next Friday,
finance category."* Claude reads the email via Gmail, confirms details, and calls
`add_task` — it lands in Ledger everywhere.

---

## Security notes

- The URL secret is your access control — treat the full URL like a password.
  Anyone with it can edit your tracker. Rotate by changing `LEDGER_MCP_SECRET`.
- The service account key grants full database access — only store it in your
  host's environment variables, never in the repo (`.gitignore` already blocks
  `.env` and `*service-account*.json`).
- For stronger auth later, this can be upgraded to OAuth 2.1; the URL secret is
  the pragmatic choice for a single-user personal connector.
