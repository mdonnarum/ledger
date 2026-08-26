/**
 * Ledger ⇄ Gemini bridge (Google Apps Script)
 * ------------------------------------------------------------------
 * Lets you SPEAK TO GEMINI to add tasks to Ledger.
 *
 * How it works:
 *   You: "Hey Gemini, add a task to call the dentist Friday"
 *      → Gemini creates a Google Task (native)
 *      → this script (on a timer) copies NEW Google Tasks into Ledger's
 *        Firestore document (ledger/main) — the same one the app uses
 *      → the task shows up in the Ledger app on every device.
 *
 * It is non-destructive: it remembers which Google Tasks it has already
 * imported (in Script Properties) and won't duplicate them. Optionally it
 * can mark the Google Task complete after import (see COMPLETE_AFTER_IMPORT).
 *
 * SETUP: see README.md in this folder. In short —
 *   1) Services (+) → add "Tasks API".
 *   2) Libraries (+) → add FirestoreApp
 *      (script id: 1VUSl4b1r1eoNcRWotZM3e87ygkxvXltOgyDZhixqncz9lQ3MjfT1iKFw)
 *   3) Project Settings → Script properties → add:
 *        FIREBASE_CLIENT_EMAIL   (client_email from the service-account JSON)
 *        FIREBASE_PRIVATE_KEY    (private_key from that JSON, incl. BEGIN/END lines)
 *        FIREBASE_PROJECT_ID     ledger-app-732df
 *   4) Run importTasksToLedger once (authorize), then add a time trigger
 *      (Triggers → add → importTasksToLedger → every 10 minutes).
 */

// If true, imported Google Tasks are marked done in Google Tasks so they leave
// your active list. If false, they stay (we still won't re-import them).
var COMPLETE_AFTER_IMPORT = true;

// Which Google Tasks list to watch. '@default' is the one Gemini writes to.
var TASK_LIST = '@default';

// Default Ledger fields for imported tasks.
var DEFAULT_PRIORITY = 'med';

// Tiny keyword → Ledger category guess (matches the app's default categories).
// Falls back to the first category in your board.
var CATEGORY_HINTS = [
  ['finance', ['bill','pay','invoice','tax','bank','rent','mortgage','insurance','budget','refund']],
  ['health',  ['doctor','dentist','appointment','prescription','pharmacy','gym','therapy','medical','vaccine']],
  ['home',    ['clean','repair','fix','grocery','groceries','laundry','yard','trash','furniture','landlord']],
  ['work',    ['meeting','email','client','report','deadline','project','invoice','presentation','deploy']]
];

function importTasksToLedger() {
  var props = PropertiesService.getScriptProperties();
  var seen = JSON.parse(props.getProperty('SEEN_TASK_IDS') || '{}');

  // 1) Pull open Google Tasks (created by Gemini / you).
  var resp = Tasks.Tasks.list(TASK_LIST, { showCompleted: false, maxResults: 100 });
  var items = (resp && resp.items) || [];
  var fresh = items.filter(function (t) { return t.title && !seen[t.id]; });
  if (!fresh.length) { Logger.log('No new Google Tasks to import.'); return; }

  // 2) Load the Ledger board once.
  var fs = getFirestore_();
  var doc = fs.getDocument('ledger/main');
  var board = doc.obj || {};
  board.tasks = board.tasks || [];
  board.cats  = (board.cats && board.cats.length) ? board.cats : [{ id: 'personal', name: 'Personal' }];

  // 3) Convert and prepend each new Google Task.
  var added = 0;
  fresh.forEach(function (t) {
    board.tasks.unshift(googleTaskToLedger_(t, board.cats));
    seen[t.id] = Date.now();
    added++;
    if (COMPLETE_AFTER_IMPORT) {
      try {
        t.status = 'completed';
        Tasks.Tasks.update(t, TASK_LIST, t.id);
      } catch (e) { Logger.log('Could not complete task ' + t.id + ': ' + e); }
    }
  });

  // 4) Write back only the fields we touched.
  board.savedAt = Date.now();
  fs.updateDocument('ledger/main', { tasks: board.tasks, savedAt: board.savedAt }, true);

  props.setProperty('SEEN_TASK_IDS', JSON.stringify(pruneSeen_(seen)));
  Logger.log('Imported ' + added + ' task(s) into Ledger.');
}

function googleTaskToLedger_(t, cats) {
  return {
    id: uid_(),
    title: t.title,
    cat: guessCat_(t.title + ' ' + (t.notes || ''), cats),
    pri: DEFAULT_PRIORITY,
    due: t.due ? t.due.slice(0, 10) : '',   // RFC3339 → YYYY-MM-DD
    repeat: 'none',
    notes: (t.notes || '') + (t.notes ? '\n' : '') + 'Added by voice via Gemini',
    done: false,
    status: 'todo',
    created: Date.now(),
    touched: Date.now(),
    pushes: 0,
    subtasks: []
  };
}

function guessCat_(text, cats) {
  var s = (text || '').toLowerCase();
  for (var i = 0; i < CATEGORY_HINTS.length; i++) {
    var id = CATEGORY_HINTS[i][0], words = CATEGORY_HINTS[i][1];
    if (words.some(function (w) { return s.indexOf(w) >= 0; })) {
      var hit = cats.find(function (c) { return c.id === id; });
      if (hit) return hit.id;
    }
  }
  return cats[0].id;
}

function uid_() { return Math.random().toString(36).slice(2, 10); }

// Keep the seen-set from growing forever: drop entries older than 60 days.
function pruneSeen_(seen) {
  var cutoff = Date.now() - 60 * 86400000, out = {};
  Object.keys(seen).forEach(function (k) { if (seen[k] > cutoff) out[k] = seen[k]; });
  return out;
}

function getFirestore_() {
  var p = PropertiesService.getScriptProperties();
  var email = p.getProperty('FIREBASE_CLIENT_EMAIL');
  var key   = p.getProperty('FIREBASE_PRIVATE_KEY');
  var proj  = p.getProperty('FIREBASE_PROJECT_ID');
  if (!email || !key || !proj) {
    throw new Error('Missing FIREBASE_* script properties — see README.md');
  }
  // Script Properties often store the key with literal \n — restore real newlines.
  key = key.replace(/\\n/g, '\n');
  return FirestoreApp.getFirestore(email, key, proj);
}
