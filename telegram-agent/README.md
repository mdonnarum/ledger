# Ledger Assistant — a personal agent you talk to (Telegram)

This is the "talk to it like a person, and it reaches out to you" agent.

- **You → it:** message a Telegram bot (type, or tap your phone keyboard's
  🎤 mic for free voice→text). It reads your Ledger board and does the work for
  you — creating tasks, breaking a described project into a **full plan**,
  updating, completing, adding bills and notes — **autonomously**. No app to
  open, nothing to approve.
- **It → you:** a scheduled heartbeat reviews your board a few times a day and
  texts you what's overdue, due today, or coming up — a real reminder to your
  phone.

It runs **100% inside Google Apps Script** — free, no server — and reuses the
**same Firebase service-account** your Gemini bridge already uses. It does **not**
depend on the MCP connector.

> Voice today = your phone keyboard's mic dictating into the Telegram box (works
> great on Android, free). True voice-note transcription can be added later.

---

## What it can do for you

Just talk to it. Examples:

- *"I'm hosting Thanksgiving this year — set that up."* → creates a **project**
  with a dedicated category and a full set of dated tasks and subtasks.
- *"Add: call the accountant about the 1099, high priority, Friday."*
- *"Mark the electric bill paid."* / *"What's overdue?"* / *"Move the dentist
  task to next week."*
- *"Remember I hate scheduling calls before 10am."* → saved to long-term memory
  and used from then on.

Board changes happen without asking. Outward actions (email, texting other
people) are deliberately **not** wired up yet — so there's nothing that can act
on the outside world without you.

---

## One-time setup (~15 min)

You'll need two things:

- Your **Firebase service-account JSON** (same one the Gemini bridge uses:
  Firebase console → Project settings → Service accounts → Generate new private
  key).
- Your **Anthropic API key** (the same one the Ledger app uses).

### 1. Create the Apps Script project
1. Go to **script.google.com → New project**, name it "Ledger Assistant".
2. Delete the sample code and paste in **`Code.gs`** from this folder.

### 2. Add the Firestore library
- **Libraries** (`+`) → paste this Script ID → **Look up** → **Add**
  (identifier stays `FirestoreApp`):
  ```
  1VUSl4b1r1eoNcRWotZM3e87ygkxvXltOgyDZhixqncz9lQ3MjfT1iKFw
  ```

### 3. Add Script Properties
⚙ **Project Settings → Script properties** → add these
(paste the private key straight here — never into a chat):

| Property | Value |
|----------|-------|
| `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
| `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON (incl. the BEGIN/END lines) |
| `FIREBASE_PROJECT_ID` | `ledger-app-732df` |
| `ANTHROPIC_API_KEY` | your Anthropic API key |
| `TELEGRAM_BOT_TOKEN` | from step 4 |

### 4. Create your Telegram bot
1. In Telegram, message **@BotFather** → `/newbot` → pick a name and username.
2. It gives you a **token** like `123456:ABC-DEF...`. Paste it into the
   `TELEGRAM_BOT_TOKEN` script property above.

### 5. Deploy as a Web App (this is Telegram's inbox)
1. **Deploy → New deployment** → gear icon → **Web app**.
2. **Execute as:** Me. **Who has access:** **Anyone**.
   (Required so Telegram can reach it. The code only responds to *your* chat —
   see "Is this private?" below.)
3. **Deploy**, approve the permission prompts, and **copy the Web app URL**
   (ends in `/exec`).
4. Add one more script property:

   | Property | Value |
   |----------|-------|
   | `WEB_APP_URL` | the `/exec` URL you just copied |

### 6. Turn on the webhook
- In the editor, choose the **`setWebhook`** function from the dropdown → **Run**.
- Check the log says `"ok":true`.

### 7. Turn on proactive reminders
- **Triggers** (clock icon) → **Add Trigger**:
  - Function: **`heartbeat`**
  - Event source: **Time-driven** → **Hour timer** → **Every 3 hours**
    (or whatever cadence you like).

### 8. Say hi
- Message your bot: **"hi"**. The first chat to message it becomes the owner.
- Try: *"I'm planning a two-week trip to Italy in May, set it up."*

---

## Verify it's working

Run the **`testConnection`** function once (Run ▶). The log should show
Firestore, Anthropic, and Telegram all OK, and (once you've messaged the bot)
you'll get a "✅ connected" message.

---

## Is this private?

The Web App URL is public (Telegram needs to reach it), but the code uses
**trust-on-first-use**: the first Telegram chat to message the bot is saved as
`OWNER_CHAT_ID`, and every message from any other chat is silently ignored. So
**message your own bot first**, before sharing its username with anyone. To reset
the owner, delete the `OWNER_CHAT_ID` script property.

Your API keys and service-account key live only in Script Properties, never in
messages.

---

## Choosing the model

`Code.gs` defaults to `claude-sonnet-4-6` (the model your Ledger app already
uses) so it works with your key on the first try. To upgrade, change one line
near the top of `Code.gs`:

```js
var MODEL = 'claude-sonnet-4-6'; // → 'claude-sonnet-5' (cheaper, strong) or 'claude-opus-5' (most capable)
```

---

## How it fits with the rest of Ledger

Everything reads and writes the **same** `ledger/main` Firestore document:

- The **web app** — your dashboard and manual editing.
- The **Gemini bridge** — Google Tasks mirror ("Hey Google, add a task…").
- **This assistant** — the conversational agent + proactive reminders.

A change made in any one shows up in all of them.

---

## Troubleshooting

- **Bot doesn't reply:** run `webhookInfo` and check `url` is your `/exec` URL and
  `last_error_message` is empty. If you redeploy and the URL changes, update
  `WEB_APP_URL` and run `setWebhook` again.
- **"Missing … script property":** re-check the table in step 3.
- **Anthropic API error about the model:** switch `MODEL` to `claude-sonnet-4-6`
  (see above).
- **No reminders arriving:** confirm the `heartbeat` time trigger exists, and
  that you've messaged the bot at least once (so it knows where to reach you).
  It only messages you when something actually needs attention, and won't repeat
  the same alert.
