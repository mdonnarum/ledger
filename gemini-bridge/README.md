# Ledger ⇄ Gemini bridge

Speak to **Gemini** and have the task land in **Ledger** — 100% inside Google,
free, no server to host.

```
You: "Hey Gemini, add a task to call the dentist Friday"
   → Gemini creates a Google Task (it does this natively)
   → this Apps Script copies new Google Tasks into Ledger's database (ledger/main)
   → it appears in the Ledger app on every device
```

It is non-destructive (remembers what it already imported) and runs on a timer,
so a task you dictate shows up in Ledger within a few minutes.

> What this does and doesn't do: Gemini gives you fast **voice capture** — it
> makes the task you dictate. It does **not** read a specific email and extract
> the task (that's the Claude + Gmail path). Many people use both.

---

## One-time setup (~10 min)

You need the **Firebase service-account JSON** (same one from the Claude
connector's Step A: Firebase console → Project settings → Service accounts →
Generate new private key).

1. Go to **script.google.com** → **New project**. Name it "Ledger Gemini Bridge".
2. Delete the sample code and paste in the contents of **`Code.gs`** from this folder.
3. **Add the Tasks API:**
   - Left sidebar → **Services** (the `+` next to Services) → find **Tasks API** → **Add**.
4. **Add the Firestore library:**
   - Left sidebar → **Libraries** (the `+`) → paste this Script ID and **Look up**, then **Add**:
     ```
     1VUSl4b1r1eoNcRWotZM3e87ygkxvXltOgyDZhixqncz9lQ3MjfT1iKFw
     ```
     (This is the well-known `FirestoreApp` library. Pick the latest version. Keep the identifier as `FirestoreApp`.)
5. **Add your credentials** — ⚙ **Project Settings** → scroll to **Script Properties** → **Add script property** (add all three):
   | Property | Value |
   |----------|-------|
   | `FIREBASE_CLIENT_EMAIL` | the `client_email` from the service-account JSON |
   | `FIREBASE_PRIVATE_KEY` | the `private_key` from that JSON (include the `-----BEGIN…` / `…END-----` lines) |
   | `FIREBASE_PROJECT_ID` | `ledger-app-732df` |
6. **Authorize & test:** top bar → function dropdown → **importTasksToLedger** → **Run**. Approve the permission prompts (Tasks + external requests). First run with no new tasks just logs "No new Google Tasks to import."
7. **Make it automatic:** left sidebar → **Triggers** (clock icon) → **Add Trigger**:
   - Function: `importTasksToLedger`
   - Event source: **Time-driven** → **Minutes timer** → **Every 10 minutes** → Save.

Done. Now say to Gemini: *"add a task to …"* → wait a few minutes → check Ledger.

---

## Notes & options (top of `Code.gs`)

- `COMPLETE_AFTER_IMPORT` (default `true`): after importing, marks the Google
  Task done so it leaves your active list. Set `false` to keep it in Google Tasks.
- `TASK_LIST` (default `@default`): the list Gemini writes to. Leave as-is unless
  you deliberately use a different list.
- **Category guessing:** imported tasks get a best-guess category from keywords
  (e.g. "dentist" → Health, "pay rent" → Finance), priority defaults to `med`,
  and the due date comes from the Google Task. Refine anything in the app.
- **Tip for phrasing:** say *"add a task to X on Friday"* so Gemini captures a
  due date. If Gemini ever routes your request to Calendar instead of Tasks,
  tell me — I can add a calendar-watching variant.
- **Cost/limits:** free. Apps Script time triggers and the Tasks/Firestore
  calls are well within Google's free quotas for personal use.
