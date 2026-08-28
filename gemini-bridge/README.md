# Ledger ⇄ Google Tasks (two-way) — the Gemini bridge

Consumer Gemini can't connect to a custom database, but it **can** read and
write **Google Tasks** natively. So this keeps Google Tasks as a live, two-way
mirror of your Ledger tasks — and Google Tasks becomes your Gemini interface to
Ledger:

```
"Hey Google, add a task to call the dentist Friday"  → appears in Ledger
"Hey Google, mark the dentist task done"             → completes it in Ledger
"Hey Google, what are my tasks?"                     → reads the mirror
...and adds/completions you make in the Ledger app flow back to Google Tasks.
```

100% inside Google, free, no server. Reuses the same Firebase service-account
key as the Claude connector.

## Sync rules (simple + loop-proof)

| Action | Direction |
|--------|-----------|
| New task (either side) | created on the other |
| Complete a task (either side) | completed on the other |
| Edit title / due date | **Ledger wins** — pushed out to Google |
| Delete | not hard-synced (safe): a Ledger delete leaves a completed item in Google; a Google delete leaves the Ledger task |

The mapping is stored on the Ledger task itself (`gtask` field) in Firestore, so
it's durable and there's no fragile external state to corrupt.

> **Honest caveat:** the *write* path (Gemini adding/completing tasks) is solid.
> Whether *"what are my tasks?"* reads them back depends on your Gemini build's
> Google Tasks support, which varies — verify it early (below). Even if read-back
> is limited, hands-free add/complete still works.

---

## One-time setup (~10 min)

You need the **Firebase service-account JSON** (Firebase console → Project
settings → Service accounts → Generate new private key).

1. **script.google.com → New project**, name it "Ledger Gemini Bridge".
2. Delete the sample code, paste in **`Code.gs`** from this folder.
3. **Services** (`+`) → add **Tasks API**.
4. **Libraries** (`+`) → add **FirestoreApp** — paste this Script ID, Look up, Add (identifier stays `FirestoreApp`):
   ```
   1VUSl4b1r1eoNcRWotZM3e87ygkxvXltOgyDZhixqncz9lQ3MjfT1iKFw
   ```
5. ⚙ **Project Settings → Script properties** → add three (paste the private key straight here — never into a chat):
   | Property | Value |
   |----------|-------|
   | `FIREBASE_CLIENT_EMAIL` | `client_email` from the JSON |
   | `FIREBASE_PRIVATE_KEY` | `private_key` from the JSON (incl. BEGIN/END lines) |
   | `FIREBASE_PROJECT_ID` | `ledger-app-732df` |
6. Function dropdown → **syncTasks** → **Run**. Approve the permission prompts.
7. **Triggers** (clock) → **Add Trigger** → `syncTasks`, Time-driven → Minutes → **Every minute** → Save.

## Verify (2 quick tests)

1. **Ledger → Google:** open the Ledger app, confirm your existing open tasks
   appear in Google Tasks (tasks.google.com) within a minute.
2. **Gemini → Ledger:** say *"Hey Google, add a task to test Ledger tomorrow"* →
   confirm it lands in Google Tasks, then in Ledger a minute later.
3. **Read-back:** say *"Hey Google, what are my tasks?"* — if it lists them, you
   have the full loop. If not, that's the Gemini-read limitation; add/complete
   still work.

## Notes

- Mirrors the **`@default`** Google Tasks list (what Gemini uses). If you'd
  rather isolate Ledger to its own list, tell me and I'll switch it.
- Reopening a *completed* task on the Google side isn't synced back (Ledger is
  the source of truth for completion) — reopen it in Ledger instead.
- Free within Google's quotas for personal use, even at a 1-minute cadence.
