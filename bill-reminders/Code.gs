/**
 * Ledger Bill Reminders — proactive email nudges (Google Apps Script)
 * ------------------------------------------------------------------
 * The piece the user cares about most: "hey, you forgot to pay this bill."
 * Runs on a schedule, reads your Ledger board, and EMAILS you when a bill is
 * past due or coming up — plus a short "what's pressing" summary.
 *
 * It names the ACTUAL MONTHS you missed. A bill's due date only advances when
 * you pay it (see the app / pay_bill), so if a monthly bill is still "due" back
 * in September, we roll it forward cycle-by-cycle and report every occurrence
 * that has passed:  "Electric — missed September and October (2 payments, $240)."
 *
 * Deterministic date math — no AI needed here, so the months are always right,
 * it costs nothing to run, and it needs no Anthropic key. (The conversational
 * agent is separate; this is just the reliable outbound reminder.)
 *
 * SETUP (~10 min): see README.md. In short:
 *   1. New Apps Script project, paste this file.
 *   2. Libraries (+) → add FirestoreApp (Script ID in README).
 *   3. Script Properties → FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
 *      FIREBASE_PROJECT_ID (same as the Gemini bridge). Optional: ALERT_EMAIL
 *      (defaults to your own Google account) and LEDGER_URL (link back to the app).
 *   4. Run sendBillReminder once to authorize + get a test email.
 *   5. Triggers (clock) → add sendBillReminder, Time-driven → Day timer → 7–8am.
 */

/* ============================ CONFIG ============================ */
var BOARD_PATH = 'ledger/main';
// How many days ahead counts as "due soon".
var SOON_DAYS = 5;

/* ============================ STORAGE ============================ */
function props_() { return PropertiesService.getScriptProperties(); }

function getFirestore_() {
  var p = props_();
  var email = p.getProperty('FIREBASE_CLIENT_EMAIL');
  var key = p.getProperty('FIREBASE_PRIVATE_KEY');
  var proj = p.getProperty('FIREBASE_PROJECT_ID');
  if (!email || !key || !proj) throw new Error('Missing FIREBASE_* script properties — see README.md');
  key = key.replace(/\\n/g, '\n');
  return FirestoreApp.getFirestore(email, key, proj);
}

function getBoard_() {
  var doc = getFirestore_().getDocument(BOARD_PATH);
  var b = (doc && doc.obj) ? doc.obj : {};
  b.tasks = b.tasks || []; b.bills = b.bills || []; b.cats = b.cats || [];
  return b;
}

/* ============================ DATE HELPERS ============================ */
function today0_() { var d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function parseDue_(s) { if (!s) return null; var d = new Date(s + 'T00:00:00'); return isNaN(d) ? null : d; }
function dayDiff_(s) { var d = parseDue_(s); if (!d) return null; return Math.round((d - today0_()) / 86400000); }
function money_(n) { return '$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Advance a date by one billing cycle.
function stepCycle_(d, cadence, interval, unit) {
  var x = new Date(d);
  switch (cadence) {
    case 'weekly': x.setDate(x.getDate() + 7); break;
    case 'biweekly': x.setDate(x.getDate() + 14); break;
    case 'quarterly': x.setMonth(x.getMonth() + 3); break;
    case 'annual': x.setFullYear(x.getFullYear() + 1); break;
    case 'custom':
      interval = interval || 1; unit = unit || 'month';
      if (unit === 'day') x.setDate(x.getDate() + interval);
      else if (unit === 'week') x.setDate(x.getDate() + 7 * interval);
      else if (unit === 'year') x.setFullYear(x.getFullYear() + interval);
      else x.setMonth(x.getMonth() + interval);
      break;
    default: x.setMonth(x.getMonth() + 1); // monthly
  }
  return x;
}

// Every unpaid occurrence whose due date is on or before today.
// For a recurring bill still sitting on an old due date, this is each missed
// cycle from that date forward; for a one-off, it's just the single date.
function missedOccurrences_(bill) {
  var start = parseDue_(bill.due);
  if (!start) return [];
  var t = today0_();
  if (bill.type === 'oneoff') return start <= t ? [start] : [];
  var occ = [], d = start, guard = 0;
  while (d <= t && guard < 400) { occ.push(new Date(d)); d = stepCycle_(d, bill.cadence, bill.interval, bill.unit); guard++; }
  return occ;
}

// Human month label, adding the year only when it isn't the current year.
function monthLabel_(d) {
  var tz = Session.getScriptTimeZone();
  var thisYear = (new Date()).getFullYear();
  return Utilities.formatDate(d, tz, d.getFullYear() === thisYear ? 'MMMM' : 'MMMM yyyy');
}

function joinList_(arr) {
  if (arr.length <= 1) return arr.join('');
  if (arr.length === 2) return arr[0] + ' and ' + arr[1];
  return arr.slice(0, -1).join(', ') + ', and ' + arr[arr.length - 1];
}

/* ============================ REPORT ============================ */
function buildReport_(b) {
  var missed = [], soon = [];
  b.bills.filter(function (x) { return !x.paused && !x.income && x.due; }).forEach(function (x) {
    var occ = missedOccurrences_(x);
    if (occ.length) {
      var months = occ.map(monthLabel_);
      missed.push({ name: x.name, count: occ.length, months: months,
        total: occ.length * Number(x.amount || 0), amount: Number(x.amount || 0),
        oldest: Utilities.formatDate(occ[0], Session.getScriptTimeZone(), 'MMM d, yyyy'),
        autopay: !!x.autopay });
    } else {
      var d = dayDiff_(x.due);
      if (d != null && d >= 0 && d <= SOON_DAYS) soon.push({ name: x.name, amount: Number(x.amount || 0), due: x.due, inDays: d, autopay: !!x.autopay });
    }
  });
  var open = b.tasks.filter(function (t) { return !t.done; });
  var overdueTasks = open.filter(function (t) { var d = dayDiff_(t.due); return d != null && d < 0; })
    .sort(function (a, c) { return dayDiff_(a.due) - dayDiff_(c.due); });
  var todayTasks = open.filter(function (t) { return dayDiff_(t.due) === 0; });
  var weekTasks = open.filter(function (t) { var d = dayDiff_(t.due); return d != null && d >= 1 && d <= 7; })
    .sort(function (a, c) { return dayDiff_(a.due) - dayDiff_(c.due); });
  // "Stalled": open, no due-date pressure, untouched for two weeks — the big
  // projects and tasks that quietly go cold. Named by category so a whole
  // project stalling is obvious.
  var stalledTasks = open.filter(function (t) {
    return dayDiff_(t.due) == null && t.touched && (Date.now() - t.touched) > 14 * 86400000;
  }).sort(function (a, c) { return (a.touched || 0) - (c.touched || 0); }).slice(0, 8);
  return { missed: missed, soon: soon, overdueTasks: overdueTasks, todayTasks: todayTasks, weekTasks: weekTasks, stalledTasks: stalledTasks, cats: b.cats };
}

/* ============================ EMAIL ============================ */
function formatEmail_(r) {
  var lines = [];
  if (r.missed.length) {
    lines.push('⚠️  MISSED / PAST DUE');
    r.missed.forEach(function (m) {
      var head = m.count > 1
        ? (m.name + ' — you\'ve missed ' + joinList_(m.months) + ' (' + m.count + ' payments, ' + money_(m.total) + ' total)')
        : (m.name + ' — ' + money_(m.amount) + ' was due (' + m.months[0] + ', ' + m.oldest + ')');
      lines.push('  • ' + head + (m.autopay ? ' [autopay — verify it went through]' : ''));
    });
    lines.push('');
  }
  if (r.soon.length) {
    lines.push('📅  DUE SOON');
    r.soon.forEach(function (s) {
      lines.push('  • ' + s.name + ' — ' + money_(s.amount) + ' due ' + s.due + ' (' + (s.inDays === 0 ? 'today' : 'in ' + s.inDays + ' day' + (s.inDays === 1 ? '' : 's')) + ')' + (s.autopay ? ' [autopay]' : ''));
    });
    lines.push('');
  }
  if (r.overdueTasks.length) {
    lines.push('❗  OVERDUE TASKS');
    r.overdueTasks.slice(0, 8).forEach(function (t) { lines.push('  • ' + t.title + ' (' + Math.abs(dayDiff_(t.due)) + 'd overdue)'); });
    lines.push('');
  }
  if (r.todayTasks.length) {
    lines.push('◷  DUE TODAY');
    r.todayTasks.slice(0, 8).forEach(function (t) { lines.push('  • ' + t.title); });
    lines.push('');
  }
  if (r.weekTasks.length) {
    lines.push('🗓  COMING UP THIS WEEK');
    r.weekTasks.slice(0, 10).forEach(function (t) { lines.push('  • ' + t.title + ' (' + t.due + ')'); });
    lines.push('');
  }
  if (r.stalledTasks.length) {
    lines.push('💤  STALLED — no movement in 2+ weeks (a project going cold?)');
    var catName = function (id) { var c = (r.cats || []).filter(function (x) { return x.id === id; })[0]; return c ? c.name : ''; };
    r.stalledTasks.forEach(function (t) { var cn = catName(t.cat); lines.push('  • ' + t.title + (cn ? ' [' + cn + ']' : '')); });
    lines.push('');
  }
  var url = props_().getProperty('LEDGER_URL');
  if (url) lines.push('Talk it through in Ledger: ' + url + (url.indexOf('?') >= 0 ? '&' : '?') + 'talk=1');
  return lines.join('\n');
}

function subject_(r) {
  if (r.missed.length) {
    var totalPayments = r.missed.reduce(function (a, m) { return a + m.count; }, 0);
    return 'Ledger ⚠️ ' + totalPayments + ' missed payment' + (totalPayments === 1 ? '' : 's') + ' + your rundown';
  }
  var items = r.soon.length + r.overdueTasks.length + r.todayTasks.length;
  if (r.overdueTasks.length) return 'Ledger — ' + r.overdueTasks.length + ' overdue, ' + r.todayTasks.length + ' due today';
  if (r.todayTasks.length || r.soon.length) return 'Ledger — your daily rundown (' + items + ' pressing)';
  return 'Ledger — your daily rundown';
}

/* ============================ MAIN (put this on a time trigger) ============================ */
function sendBillReminder() {
  var b = getBoard_();
  var r = buildReport_(b);
  var count = r.missed.length + r.soon.length + r.overdueTasks.length + r.todayTasks.length + r.weekTasks.length + r.stalledTasks.length;
  if (!count) return; // nothing worth an email

  // De-dupe: don't resend an identical situation on every run. But if a bill is
  // MISSED, allow one nudge per day even when unchanged — missed bills should
  // keep reminding you until handled.
  var sig = JSON.stringify({
    m: r.missed.map(function (m) { return m.name + ':' + m.count; }),
    s: r.soon.map(function (s) { return s.name + ':' + s.due; }),
    ot: r.overdueTasks.length, tt: r.todayTasks.length, wk: r.weekTasks.length, st: r.stalledTasks.length
  });
  var todayStr = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  var lastSig = props_().getProperty('LAST_BILL_SIG');
  var lastDay = props_().getProperty('LAST_BILL_DAY');
  var changed = sig !== lastSig;
  var newDayWithMissed = r.missed.length && lastDay !== todayStr;
  if (!changed && !newDayWithMissed) return;

  var to = props_().getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, subject_(r), formatEmail_(r));
  props_().setProperty('LAST_BILL_SIG', sig);
  props_().setProperty('LAST_BILL_DAY', todayStr);
}

/* ============================ HELPERS (run manually) ============================ */
// See what the next email would say, in the execution log, without sending.
function previewReminder() {
  var r = buildReport_(getBoard_());
  Logger.log('Subject: ' + subject_(r));
  Logger.log('\n' + (formatEmail_(r) || '(nothing pressing — no email would be sent)'));
}
// Force-send right now (ignores the de-dupe), to test delivery.
function testSendNow() {
  var r = buildReport_(getBoard_());
  var to = props_().getProperty('ALERT_EMAIL') || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail(to, subject_(r) + ' (test)', formatEmail_(r) || 'Nothing pressing right now — this is a delivery test.');
  Logger.log('Sent test to ' + to);
}
