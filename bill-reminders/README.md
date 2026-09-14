# Ledger Daily Briefing + Reminders (email)

Your proactive assistant that reaches out — covering your **whole board, not just
bills**. Runs on a schedule, reads your Ledger board, and **emails you** a
rundown of everything pressing:

- ⚠️ **Missed / past-due bills** — named by the actual months (see below)
- 📅 **Bills due soon**
- ❗ **Overdue tasks** and ◷ **due today**
- 🗓 **Coming up this week**
- 💤 **Stalled** tasks/projects — open items with no movement in 2+ weeks, so a
  big project (a move, taxes, a job search) can't quietly go cold

The "hey, you forgot to pay this" nudge is the piece you flagged as most
important, so bills lead — but this is a full life rundown, not just bills.

It names the **actual months** you missed. Because a bill's due date only moves
forward when you pay it, a monthly bill still sitting on its September due date is
clearly also past October — so you get:

> ⚠️ MISSED / PAST DUE
> • Electric — you've missed **September and October** (2 payments, $240.00 total)

Not a vague "you missed a payment." This is plain date math, so the months are
always right, it costs nothing to run, and it needs **no AI key** — separate from
the conversational agent.

Runs 100% in Google Apps Script, reusing the **same Firebase service account** as
the Gemini bridge.

---

## One-time setup (~10 min)

You need your **Firebase service-account JSON** (Firebase console → Project
settings → Service accounts → Generate new private key) — the same one the
Gemini bridge uses.

1. **script.google.com → New project**, name it "Ledger Bill Reminders".
2. Delete the sample code, paste in **`Code.gs`** from this folder.
3. **Libraries** (`+`) → add **FirestoreApp** (paste this Script ID → Look up →
   Add; identifier stays `FirestoreApp`):
   ```
   1VUSl4b1r1eoNcRWotZM3e87ygkxvXltOgyDZhixqncz9lQ3MjfT1iKFw
   ```
4. ⚙ **Project Settings → Script properties** → add:

   | Property | Value |
   |----------|-------|
   | `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
   | `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON (incl. BEGIN/END lines) |
   | `FIREBASE_PROJECT_ID` | `ledger-app-732df` |
   | `ALERT_EMAIL` *(optional)* | where to send alerts — defaults to your own Google account |
   | `LEDGER_URL` *(optional)* | your Ledger app URL, so emails include a "tap to talk it through" link |

5. Function dropdown → **`sendBillReminder`** → **Run**. Approve the permission
   prompts (it needs Firestore access + permission to send mail as you). You'll
   get a test email if anything is pending.
6. **Triggers** (clock icon) → **Add Trigger** → `sendBillReminder`,
   **Time-driven → Day timer → 7am–8am**. (You can add a second trigger, e.g.
   an evening one, if you want more nudges.)

## Verify

- **`previewReminder`** — Run it, then open **Executions**/log to see exactly what
  the next email would say, without sending.
- **`testSendNow`** — force-sends an email right now to confirm delivery.

## Good to know

- **No spam:** it won't resend the same situation over and over. If a bill is
  *missed*, it will nudge you once a day until you handle it; otherwise it only
  emails when something changes.
- **Autopay bills** are still listed if their due date passed, tagged
  `[autopay — verify it went through]`, since autopay can silently fail.
- **How it knows a bill is paid:** paying it in the app (or via the assistant)
  advances its due date, which clears it from the missed list automatically.
- Everything reads the same `ledger/main` Firestore document as the app, so it's
  always in sync.
