/**
 * Ledger ⇄ Google Tasks — TWO-WAY sync (Google Apps Script)
 * ------------------------------------------------------------------
 * Makes Google Tasks a live mirror of your Ledger tasks, so you can manage
 * Ledger by talking to Gemini (which speaks Google Tasks natively):
 *
 *   "Hey Google, add a task to call the dentist Friday"  → shows up in Ledger
 *   "Hey Google, mark the dentist task done"             → completes in Ledger
 *   "Hey Google, what are my tasks?"                     → reads the mirror
 *   ...and anything you add/finish in the Ledger app flows back to Google Tasks.
 *
 * DESIGN (kept simple + loop-proof):
 *   • The mapping lives on the Ledger task itself (t.gtask = Google Task id),
 *     stored in Firestore — durable, no fragile external state.
 *   • New task on EITHER side  → created on the other.
 *   • Complete on EITHER side  → completed on the other.
 *   • Content edits (title/due) → Ledger is the source of truth, pushed OUT to
 *     Google. (Editing wording in Gemini is rare; Ledger wins to avoid ping-pong.)
 *   • Deletes are NOT hard-synced (safe by design): deleting in Ledger leaves a
 *     completed item in Google; deleting in Google leaves the Ledger task.
 *
 * SETUP: see README.md. Services → Tasks API. Libraries → FirestoreApp. Add the
 * FIREBASE_* script properties. Run syncTasks once to authorize, then add a
 * time trigger (Every minute).
 */

// Which Google Tasks list to mirror. '@default' is the list Gemini reads/writes.
var TASK_LIST = '@default';
var DEFAULT_PRIORITY = 'med';

// Light keyword → Ledger category guess (matches the app's default categories).
var CATEGORY_HINTS = [
  ['finance', ['bill','pay','invoice','tax','bank','rent','mortgage','insurance','budget','refund']],
  ['health',  ['doctor','dentist','appointment','prescription','pharmacy','gym','therapy','medical','vaccine']],
  ['home',    ['clean','repair','fix','grocery','groceries','laundry','yard','trash','furniture','landlord']],
  ['work',    ['meeting','email','client','report','deadline','project','presentation','deploy']]
];

function syncTasks() {
  var fs = getFirestore_();
  var doc = fs.getDocument('ledger/main');
  var board = doc.obj || {};
  board.tasks = board.tasks || [];
  board.cats = (board.cats && board.cats.length) ? board.cats : [{ id: 'personal', name: 'Personal' }];

  var gtasks = listAllTasks_(TASK_LIST);
  var gById = {}; gtasks.forEach(function (g) { gById[g.id] = g; });
  var lByGid = {}; board.tasks.forEach(function (t) { if (t.gtask) lByGid[t.gtask] = t; });

  var changed = false;

  // ---------- Google → Ledger ----------
  gtasks.forEach(function (g) {
    if (!g.title) return;
    var lt = lByGid[g.id];
    if (!lt) {
      // Brand-new Google Task (e.g. dictated to Gemini) → import into Ledger.
      var nt = gToLedger_(g, board.cats);
      nt.gtask = g.id;
      if (g.status === 'completed') { nt.done = true; nt.completed = Date.now(); }
      board.tasks.unshift(nt);
      lByGid[g.id] = nt;
      changed = true;
    } else if (g.status === 'completed' && !lt.done) {
      // Completed in Google → complete in Ledger.
      lt.done = true; lt.completed = Date.now(); lt.touched = Date.now();
      changed = true;
    }
  });

  // ---------- Ledger → Google ----------
  board.tasks.forEach(function (t) {
    var g = t.gtask ? gById[t.gtask] : null;
    if (!t.done) {
      if (!t.gtask) {
        // New Ledger task → create its Google mirror.
        var created = Tasks.Tasks.insert(ledgerToG_(t), TASK_LIST);
        t.gtask = created.id; changed = true;
      } else if (g && g.status !== 'completed') {
        // Keep Google title/due matching Ledger (Ledger wins on content).
        var patch = contentPatch_(t, g);
        if (patch) { try { Tasks.Tasks.patch(patch, TASK_LIST, g.id); } catch (e) { Logger.log('patch: ' + e); } }
      }
      // if mapped but missing in Google (deleted there) → leave Ledger as-is.
    } else if (g && g.status !== 'completed') {
      // Ledger task done → complete the Google mirror.
      try { g.status = 'completed'; Tasks.Tasks.update(g, TASK_LIST, g.id); } catch (e) { Logger.log('complete: ' + e); }
    }
  });

  if (changed) {
    board.savedAt = Date.now();
    fs.updateDocument('ledger/main', { tasks: board.tasks, savedAt: board.savedAt }, true);
  }
  Logger.log('Sync ok — ' + board.tasks.length + ' Ledger tasks, ' + gtasks.length + ' Google tasks.');
}

// ---------- conversions ----------
function gToLedger_(g, cats) {
  return {
    id: uid_(),
    title: g.title,
    cat: guessCat_(g.title + ' ' + (g.notes || ''), cats),
    pri: DEFAULT_PRIORITY,
    due: g.due ? g.due.slice(0, 10) : '',       // RFC3339 → YYYY-MM-DD
    repeat: 'none',
    notes: g.notes || '',
    done: false, status: 'todo',
    created: Date.now(), touched: Date.now(), pushes: 0,
    subtasks: []
  };
}
function ledgerToG_(t) {
  var g = { title: t.title || 'Task', notes: t.notes || '', status: 'needsAction' };
  if (t.due) g.due = t.due + 'T00:00:00.000Z';
  return g;
}
// Return a patch only if Google's title/due drifted from Ledger's.
function contentPatch_(t, g) {
  var p = {}, need = false;
  if ((g.title || '') !== (t.title || '')) { p.title = t.title || ''; need = true; }
  var gDue = g.due ? g.due.slice(0, 10) : '';
  if (gDue !== (t.due || '')) { p.due = t.due ? t.due + 'T00:00:00.000Z' : null; need = true; }
  return need ? p : null;
}

// ---------- helpers ----------
function listAllTasks_(list) {
  var out = [], token = null;
  do {
    var resp = Tasks.Tasks.list(list, { showCompleted: true, showHidden: true, maxResults: 100, pageToken: token });
    if (resp.items) out = out.concat(resp.items);
    token = resp.nextPageToken;
  } while (token);
  return out;
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
function getFirestore_() {
  var p = PropertiesService.getScriptProperties();
  var email = p.getProperty('FIREBASE_CLIENT_EMAIL');
  var key = p.getProperty('FIREBASE_PRIVATE_KEY');
  var proj = p.getProperty('FIREBASE_PROJECT_ID');
  if (!email || !key || !proj) throw new Error('Missing FIREBASE_* script properties — see README.md');
  key = key.replace(/\\n/g, '\n');
  return FirestoreApp.getFirestore(email, key, proj);
}
