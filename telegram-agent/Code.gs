/**
 * Ledger Assistant — a proactive personal agent over Telegram (Google Apps Script)
 * ---------------------------------------------------------------------------------
 * This is the "talk to it like a person, and it reaches out to you" agent.
 *
 *   • YOU → IT:  message the Telegram bot (type, or use your phone keyboard's
 *     mic for free voice→text). It runs an agentic loop with Claude that reads
 *     your Ledger board and makes changes for you — creating tasks, breaking a
 *     described project into a full plan, updating, completing, adding bills and
 *     notes — autonomously. No app to open, no changes to approve.
 *
 *   • IT → YOU:  a scheduled heartbeat reviews your board a few times a day and
 *     messages you what's slipping, overdue, or coming up — a real reminder that
 *     reaches your phone, not a calendar notification.
 *
 * WHY APPS SCRIPT:  it runs for free with no server, it can already read/write
 * your Ledger board in Firestore (same service-account pattern as the Gemini
 * bridge), it has built-in scheduled triggers for the heartbeat, and a deployed
 * Web App gives Telegram a webhook to deliver your messages to. Nothing here
 * depends on the MCP connector.
 *
 * SETUP: see README.md in this folder. In short:
 *   1. New Apps Script project, paste this file.
 *   2. Libraries (+) → add FirestoreApp (Script ID in README).
 *   3. Script Properties → FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY,
 *      FIREBASE_PROJECT_ID (same as the bridge), ANTHROPIC_API_KEY,
 *      TELEGRAM_BOT_TOKEN.
 *   4. Deploy → New deployment → Web app (execute as you, access: Anyone).
 *      Copy the /exec URL into the WEB_APP_URL script property.
 *   5. Run setWebhook() once (authorize when prompted).
 *   6. Add a time-driven trigger for heartbeat() (e.g. every 3 hours).
 *   7. Message your bot "hi".
 */

/* ============================ CONFIG ============================ */

// The board lives here in Firestore (same doc the app and bridge use).
var BOARD_PATH = 'ledger/main';

// Which Claude model answers. Defaults to the model your Ledger app already
// uses, so it's guaranteed to work with your existing API key on the first try.
// Upgrade any time by changing this one line:
//   'claude-opus-5'    — most capable (higher cost)
//   'claude-sonnet-5'  — strong + cheaper than Opus
//   'claude-sonnet-4-6'— what the app uses today (default below)
var MODEL = 'claude-sonnet-4-6';
var ANTHROPIC_VERSION = '2023-06-01';
var MAX_TOKENS = 2048;
var MAX_TOOL_ROUNDS = 6; // safety cap on the agentic loop

// Simple category palette for projects that deserve a brand-new category.
var PALETTE = ['#4DD9B0', '#5BA8F5', '#9B8CFF', '#F0A23C', '#F2586A', '#48C4E0', '#B8D94D', '#E85DA1'];

/* ============================ PROPS / STORAGE ============================ */

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
  var fs = getFirestore_();
  var doc = fs.getDocument(BOARD_PATH);
  var b = (doc && doc.obj) ? doc.obj : {};
  b.tasks = b.tasks || [];
  b.bills = b.bills || [];
  b.notes = b.notes || [];
  b.staples = b.staples || [];
  b.memory = b.memory || [];
  b.cats = (b.cats && b.cats.length) ? b.cats : [{ id: 'personal', name: 'Personal', color: '#4DD9B0' }];
  return b;
}

// Persist only the fields we manage, merged into the doc (mask = true), exactly
// like the app's save() — this preserves the bridge's gtask mappings and any
// other fields we don't touch.
function saveBoard_(b) {
  var fs = getFirestore_();
  b.savedAt = Date.now();
  fs.updateDocument(BOARD_PATH, {
    tasks: b.tasks, bills: b.bills, cats: b.cats,
    notes: b.notes, staples: b.staples, memory: b.memory, savedAt: b.savedAt
  }, true);
}

function uid_() { return Math.random().toString(36).slice(2, 10); }
function todayISO_() { return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'); }

/* ============================ BOARD HELPERS ============================ */

function findTask_(b, match) {
  if (!match) return null;
  var q = String(match).toLowerCase().trim();
  return b.tasks.filter(function (t) { return !t.done; }).find(function (t) { return (t.title || '').toLowerCase() === q; })
      || b.tasks.find(function (t) { return (t.title || '').toLowerCase() === q; })
      || b.tasks.find(function (t) { return (t.title || '').toLowerCase().indexOf(q) >= 0; });
}
function findCatId_(b, name) {
  if (!name) return (b.cats[0] && b.cats[0].id) || 'personal';
  var q = String(name).toLowerCase().trim();
  var c = b.cats.find(function (x) { return (x.name || '').toLowerCase() === q; })
       || b.cats.find(function (x) { return (x.name || '').toLowerCase().indexOf(q) >= 0; })
       || b.cats.find(function (x) { return x.id === q; });
  return c ? c.id : ((b.cats[0] && b.cats[0].id) || 'personal');
}
function findBill_(b, match) {
  if (!match) return null;
  var q = String(match).toLowerCase().trim();
  return b.bills.find(function (x) { return (x.name || '').toLowerCase() === q; })
      || b.bills.find(function (x) { return (x.name || '').toLowerCase().indexOf(q) >= 0; });
}
function newTask_(b, td) {
  return {
    id: uid_(), title: td.title || 'New task',
    cat: td.category ? findCatId_(b, td.category) : ((b.cats[0] && b.cats[0].id) || 'personal'),
    pri: td.priority || 'med', due: td.due || '', repeat: 'none',
    notes: td.notes || '', done: false, status: 'todo',
    created: Date.now(), touched: Date.now(), pushes: 0,
    subtasks: (td.subtasks || []).map(function (s) { return { id: uid_(), title: s, done: false, notes: '' }; })
  };
}
function dayDiff_(due) {
  if (!due) return null;
  var d = new Date(due + 'T00:00:00'); if (isNaN(d)) return null;
  var t = new Date(); t.setHours(0, 0, 0, 0);
  return Math.round((d - t) / 86400000);
}

/* ============================ TOOL DEFINITIONS ============================ */
// All tools here are board-only and safe, so the agent runs them autonomously.
// Outward actions (email, texting other people) are deliberately NOT exposed —
// when we add those later, they'll be the ones that ask you first.

function tools_() {
  return [
    { name: 'add_task', description: 'Create a single task on the board.',
      input_schema: { type: 'object', properties: {
        title: { type: 'string' }, category: { type: 'string', description: 'existing category name; optional' },
        priority: { type: 'string', enum: ['low', 'med', 'high', 'critical'] },
        due: { type: 'string', description: 'YYYY-MM-DD' }, notes: { type: 'string' },
        subtasks: { type: 'array', items: { type: 'string' } }
      }, required: ['title'] } },

    { name: 'add_project', description: 'Turn a described situation or goal into a whole project at once: an optional dedicated new category plus several concrete, ordered tasks (each with its own steps). Prefer this over many add_task calls whenever the user describes something bigger than one to-do.',
      input_schema: { type: 'object', properties: {
        title: { type: 'string' },
        category: { type: 'string', description: 'existing category to file under; optional' },
        new_category_name: { type: 'string', description: 'create a dedicated category with this name instead; optional' },
        tasks: { type: 'array', items: { type: 'object', properties: {
          title: { type: 'string' }, priority: { type: 'string' }, due: { type: 'string' },
          notes: { type: 'string' }, subtasks: { type: 'array', items: { type: 'string' } }
        }, required: ['title'] } }
      }, required: ['title', 'tasks'] } },

    { name: 'update_task', description: 'Change fields on an existing task, matched fuzzily by title.',
      input_schema: { type: 'object', properties: {
        match: { type: 'string' }, title: { type: 'string' }, category: { type: 'string' },
        priority: { type: 'string' }, due: { type: 'string' },
        status: { type: 'string', enum: ['todo', 'inprogress', 'blocked'] }, notes: { type: 'string' }
      }, required: ['match'] } },

    { name: 'complete_task', description: 'Mark a task done (matched by title).',
      input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } },

    { name: 'delete_task', description: 'Delete a task (matched by title).',
      input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } },

    { name: 'add_bill', description: 'Add a bill (money you pay) or income (set income:true).',
      input_schema: { type: 'object', properties: {
        name: { type: 'string' }, amount: { type: 'number' },
        cadence: { type: 'string', enum: ['monthly', 'weekly', 'biweekly', 'quarterly', 'annual', 'oneoff'] },
        due: { type: 'string' }, autopay: { type: 'boolean' }, income: { type: 'boolean' }, notes: { type: 'string' }
      }, required: ['name'] } },

    { name: 'pay_bill', description: 'Log a payment for a bill and advance its due date by one cadence.',
      input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } },

    { name: 'add_note', description: 'Save a free-form note (running context, reference info).',
      input_schema: { type: 'object', properties: {
        title: { type: 'string' }, body: { type: 'string' }, category: { type: 'string' }, pinned: { type: 'boolean' }
      }, required: ['title'] } },

    { name: 'remember', description: 'Save a durable fact about the user (goals, people, preferences, ongoing situations). Persists across every conversation.',
      input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },

    { name: 'forget', description: 'Remove a remembered fact matching some words.',
      input_schema: { type: 'object', properties: { match: { type: 'string' } }, required: ['match'] } }
  ];
}

/* ============================ TOOL EXECUTION ============================ */
// Mutates `b` in place and returns a short human-readable result string.
function executeTool_(name, input, b) {
  input = input || {};
  try {
    switch (name) {
      case 'add_task': {
        var t = newTask_(b, input); b.tasks.unshift(t);
        return '✓ Added task: "' + t.title + '"';
      }
      case 'add_project': {
        var catId, created = [];
        if (input.new_category_name) {
          var existing = b.cats.find(function (c) { return (c.name || '').toLowerCase() === String(input.new_category_name).toLowerCase(); });
          if (existing) { catId = existing.id; }
          else {
            catId = uid_();
            var used = b.cats.map(function (c) { return c.color; });
            var color = PALETTE.filter(function (c) { return used.indexOf(c) < 0; })[0] || PALETTE[b.cats.length % PALETTE.length];
            b.cats.push({ id: catId, name: input.new_category_name, color: color });
          }
        } else { catId = findCatId_(b, input.category); }
        var items = input.tasks || [];
        for (var i = items.length - 1; i >= 0; i--) {
          var td = items[i]; if (!td || !td.title) continue;
          var nt = newTask_(b, td); nt.cat = td.category ? findCatId_(b, td.category) : catId;
          b.tasks.unshift(nt); created.push(td.title);
        }
        return '✓ Created project "' + (input.title || 'Project') + '" with ' + created.length + ' task(s): ' + created.slice().reverse().join(', ');
      }
      case 'update_task': {
        var ut = findTask_(b, input.match);
        if (!ut) return '✗ Task not found: "' + input.match + '"';
        if (input.title != null) ut.title = input.title;
        if (input.category != null) ut.cat = findCatId_(b, input.category);
        if (input.priority != null) ut.pri = input.priority;
        if (input.due != null) ut.due = input.due;
        if (input.status != null) ut.status = input.status;
        if (input.notes != null) ut.notes = input.notes;
        ut.touched = Date.now();
        return '✓ Updated: "' + ut.title + '"';
      }
      case 'complete_task': {
        var ct = findTask_(b, input.match);
        if (!ct) return '✗ Task not found: "' + input.match + '"';
        ct.done = true; ct.completed = Date.now(); ct.touched = Date.now();
        return '✓ Completed: "' + ct.title + '"';
      }
      case 'delete_task': {
        var dt = findTask_(b, input.match);
        if (!dt) return '✗ Task not found: "' + input.match + '"';
        var title = dt.title; b.tasks = b.tasks.filter(function (x) { return x.id !== dt.id; });
        return '✓ Deleted: "' + title + '"';
      }
      case 'add_bill': {
        var oneoff = input.cadence === 'oneoff';
        b.bills.unshift({
          id: uid_(), name: input.name || 'New bill', amount: Number(input.amount || 0),
          cadence: oneoff ? 'monthly' : (input.cadence || 'monthly'), type: oneoff ? 'oneoff' : 'recurring',
          due: input.due || '', lead: 3, autopay: !!input.autopay, income: !!input.income,
          notes: input.notes || '', paused: false, history: []
        });
        return '✓ Added ' + (input.income ? 'income' : 'bill') + ': "' + (input.name || 'New bill') + '"';
      }
      case 'pay_bill': {
        var pb = findBill_(b, input.match);
        if (!pb) return '✗ Bill not found: "' + input.match + '"';
        pb.history = pb.history || [];
        pb.history.push({ date: todayISO_(), amount: pb.amount });
        if (pb.due) {
          var d = new Date(pb.due + 'T00:00:00');
          if (!isNaN(d)) {
            if (pb.cadence === 'weekly') d.setDate(d.getDate() + 7);
            else if (pb.cadence === 'biweekly') d.setDate(d.getDate() + 14);
            else if (pb.cadence === 'quarterly') d.setMonth(d.getMonth() + 3);
            else if (pb.cadence === 'annual') d.setFullYear(d.getFullYear() + 1);
            else d.setMonth(d.getMonth() + 1);
            pb.due = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
          }
        }
        return '✓ Logged payment for "' + pb.name + '"' + (pb.due ? ' — next due ' + pb.due : '');
      }
      case 'add_note': {
        b.notes = b.notes || [];
        b.notes.unshift({ id: uid_(), title: input.title || 'Untitled', body: input.body || '',
          cat: findCatId_(b, input.category), taskId: '', pinned: !!input.pinned,
          created: Date.now(), modified: Date.now() });
        return '✓ Saved note: "' + (input.title || 'Untitled') + '"';
      }
      case 'remember': {
        var text = String(input.text || '').trim();
        if (!text) return '✗ Nothing to remember';
        b.memory = b.memory || [];
        if (b.memory.some(function (m) { return m.text.toLowerCase() === text.toLowerCase(); })) return '• Already knew that';
        b.memory.unshift({ id: uid_(), text: text, created: Date.now() });
        return '🧠 Noted: "' + text + '"';
      }
      case 'forget': {
        var q = String(input.match || '').toLowerCase().trim();
        if (!q) return '✗ Nothing specified';
        var before = (b.memory || []).length;
        b.memory = (b.memory || []).filter(function (m) { return m.text.toLowerCase().indexOf(q) < 0; });
        var gone = before - b.memory.length;
        return gone ? ('🧠 Forgot ' + gone + ' note(s)') : ('✗ Nothing matched "' + input.match + '"');
      }
      default: return '✗ Unknown tool: ' + name;
    }
  } catch (err) {
    return '✗ Error in ' + name + ': ' + err.message;
  }
}

/* ============================ SYSTEM PROMPT ============================ */

function buildSystemPrompt_(b) {
  var open = b.tasks.filter(function (t) { return !t.done; });
  var taskLines = open.slice(0, 60).map(function (t) {
    var d = dayDiff_(t.due);
    var when = t.due ? (d < 0 ? ' OVERDUE ' + Math.abs(d) + 'd' : (d === 0 ? ' due today' : ' due ' + t.due)) : '';
    var cat = (b.cats.find(function (c) { return c.id === t.cat; }) || {}).name || t.cat;
    var sub = (t.subtasks || []).length ? ' [' + (t.subtasks.filter(function (s) { return s.done; }).length) + '/' + t.subtasks.length + ' steps]' : '';
    return '- "' + t.title + '" (' + cat + '/' + t.pri + when + ')' + sub + (t.notes ? ' — ' + String(t.notes).slice(0, 100) : '');
  }).join('\n');
  var billLines = b.bills.map(function (x) {
    return '- "' + x.name + '" ' + (x.income ? 'INCOME' : 'bill') + ' $' + (x.amount || 0) + ' ' + (x.cadence || '') + (x.due ? ' due ' + x.due : '') + (x.paused ? ' PAUSED' : '');
  }).join('\n');
  var mem = (b.memory || []).map(function (m) { return '- ' + m.text; }).join('\n') || '(nothing yet)';
  var cats = b.cats.map(function (c) { return c.name; }).join(', ');

  return [
    'You are Ledger — a warm, capable personal assistant that manages the user\'s task board for them over a Telegram chat. You are proactive, not a passive command box: you create and combine tasks, break big things into concrete plans, keep bills and notes straight, and remember what matters.',
    '',
    'TODAY: ' + new Date().toDateString() + ' (dates are YYYY-MM-DD).',
    'CATEGORIES: ' + cats,
    '',
    'WHAT YOU KNOW ABOUT THE USER (long-term memory):',
    mem,
    '',
    'OPEN TASKS (' + open.length + '):',
    taskLines || '(none)',
    '',
    'BILLS & INCOME:',
    billLines || '(none)',
    '',
    'HOW TO ACT:',
    '- You have full autonomy over the BOARD. Just make the change with a tool — never ask "should I add this?". Do it, then tell them plainly what you did.',
    '- FILL IN THE BLANKS with your own knowledge. When the user names a project, do NOT just echo their words — think through what that undertaking actually involves and build the real plan. "Doing my taxes" → gather W-2s/1099s, last year\'s return, deductions, file federal, file state, pay any balance. "Renting a house" → budget, application + fee, credit/income proof, deposit, lease review, renter\'s insurance, utilities setup, moving. "Passport renewal" → form DS-82, photo, current passport, fee, mail/appointment. "Job search" → resume, target list, applications, follow-ups, interview prep. Supply the concrete steps, documents, and realistic due dates the user didn\'t spell out.',
    '- Use add_project for anything bigger than one to-do: 3–8 concrete, ordered tasks with sensible due dates and subtasks. This is the thing they value most.',
    '- BILLS ARE THE PRIORITY. Treat anything about money owed as important. When asked what\'s pressing / due / going on today, give a short prioritized read-back — overdue bills first ("you haven\'t paid X"), then bills due soon, then overdue tasks, then what\'s due today. Keep it tight and scannable in a chat.',
    '- Interpret "tomorrow", "next Friday", "in two weeks" relative to TODAY and pass real YYYY-MM-DD dates.',
    '- Match tasks/bills fuzzily by name; pick the closest one.',
    '- When the user reveals something durable about themselves, quietly call remember.',
    '- This is a phone chat: keep replies short, natural, and free of markdown symbols, headings, or tables. A sentence or two. No preamble.',
    '- If a request is genuinely ambiguous (which of two similar tasks), ask one short question instead of guessing.'
  ].join('\n');
}

/* ============================ ANTHROPIC CALL + AGENT LOOP ============================ */

function callAnthropic_(systemText, messages, tools) {
  var key = props_().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('Missing ANTHROPIC_API_KEY script property');
  var body = { model: MODEL, max_tokens: MAX_TOKENS, system: systemText, messages: messages };
  if (tools) body.tools = tools;
  var resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify(body), muteHttpExceptions: true
  });
  var code = resp.getResponseCode();
  var data = JSON.parse(resp.getContentText() || '{}');
  if (code !== 200) {
    var msg = (data.error && data.error.message) ? data.error.message : ('HTTP ' + code);
    throw new Error('Anthropic API: ' + msg);
  }
  return data;
}

// Runs the tool-use loop. Returns the final assistant text; mutates `b`.
function runAgent_(userText, b) {
  var system = buildSystemPrompt_(b);
  var tools = tools_();
  var messages = [{ role: 'user', content: userText }];
  var finalText = '';
  var didWrite = false;

  for (var round = 0; round < MAX_TOOL_ROUNDS; round++) {
    var data = callAnthropic_(system, messages, tools);
    var content = data.content || [];
    // Collect any assistant text.
    var textThisTurn = content.filter(function (x) { return x.type === 'text'; })
      .map(function (x) { return x.text; }).join('').trim();
    if (textThisTurn) finalText = textThisTurn;

    if (data.stop_reason !== 'tool_use') break;

    // Execute every tool_use block, then feed results back.
    messages.push({ role: 'assistant', content: content });
    var results = [];
    content.filter(function (x) { return x.type === 'tool_use'; }).forEach(function (tu) {
      var out = executeTool_(tu.name, tu.input, b);
      didWrite = true;
      results.push({ type: 'tool_result', tool_use_id: tu.id, content: out });
    });
    messages.push({ role: 'user', content: results });
  }

  if (didWrite) saveBoard_(b);
  return finalText || 'Done.';
}

/* ============================ TELEGRAM ============================ */

function tgApi_(method, payload) {
  var token = props_().getProperty('TELEGRAM_BOT_TOKEN');
  if (!token) throw new Error('Missing TELEGRAM_BOT_TOKEN script property');
  var resp = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload || {}), muteHttpExceptions: true
  });
  return JSON.parse(resp.getContentText() || '{}');
}

function sendTelegram_(chatId, text) {
  if (!text) return;
  // Telegram caps messages at 4096 chars.
  tgApi_('sendMessage', { chat_id: chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
}

// Telegram delivers updates here (this file must be deployed as a Web App).
function doPost(e) {
  var ok = ContentService.createTextOutput('ok');
  try {
    var update = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    var msg = update.message || update.edited_message;
    if (!msg || !msg.chat) return ok;
    var chatId = msg.chat.id;

    // Trust-on-first-use: the first chat to message the bot becomes the owner;
    // everyone else is ignored (this webhook URL is public).
    var owner = props_().getProperty('OWNER_CHAT_ID');
    if (!owner) { props_().setProperty('OWNER_CHAT_ID', String(chatId)); owner = String(chatId); }
    if (String(chatId) !== owner) return ok;

    var text = (msg.text || '').trim();
    if (msg.voice || msg.audio) {
      sendTelegram_(chatId, "I can't listen to voice notes yet — but tap the 🎤 on your phone keyboard to dictate, then send it as text and I'll handle it just the same.");
      return ok;
    }
    if (!text) return ok;
    if (text === '/start') {
      sendTelegram_(chatId, "Hi — I'm your Ledger assistant. Tell me what's going on and I'll manage your tasks, bills and projects for you. Try: \"I'm hosting Thanksgiving this year, set that up.\"");
      return ok;
    }

    handleUserMessage_(chatId, text);
  } catch (err) {
    try { sendTelegram_(JSON.parse(e.postData.contents).message.chat.id, 'Something went wrong: ' + err.message); } catch (e2) {}
  }
  return ok;
}

function doGet() {
  return ContentService.createTextOutput('Ledger assistant is running.');
}

function handleUserMessage_(chatId, text) {
  tgApi_('sendChatAction', { chat_id: chatId, action: 'typing' });
  var b = getBoard_();
  var reply;
  try { reply = runAgent_(text, b); }
  catch (err) { reply = 'I hit a snag: ' + err.message; }
  sendTelegram_(chatId, reply);
}

/* ============================ HEARTBEAT (proactive outreach) ============================ */
// Add a time-driven trigger on heartbeat() (e.g. every 3 hours). It reviews the
// board, and if something needs the user's attention it sends them a short,
// warm nudge — a real reminder to the phone, not a calendar alert.

function pressing_(b) {
  var out = { overdueBills: [], soonBills: [], overdue: [], today: [], stalled: [] };
  b.tasks.filter(function (t) { return !t.done; }).forEach(function (t) {
    var d = dayDiff_(t.due);
    if (d != null && d < 0) out.overdue.push(t);
    else if (d === 0) out.today.push(t);
    // "stalled": old and untouched for a while, no due date pressure
    else if (d == null && t.touched && (Date.now() - t.touched) > 10 * 86400000) out.stalled.push(t);
  });
  // Bills: an unpaid bill whose due date has passed is the "you forgot to pay
  // this" case — the thing the user cares about most. Autopay bills are skipped
  // for nagging (they pay themselves). pay_bill advances the due date, so a
  // past due date means this cycle hasn't been paid.
  b.bills.filter(function (x) { return !x.paused && !x.income && x.due && !x.autopay; }).forEach(function (x) {
    var d = dayDiff_(x.due);
    if (d != null && d < 0) out.overdueBills.push(x);
    else if (d != null && d >= 0 && d <= 4) out.soonBills.push(x);
  });
  return out;
}

function heartbeat() {
  var owner = props_().getProperty('OWNER_CHAT_ID');
  if (!owner) return; // nobody has connected yet
  var b = getBoard_();
  var p = pressing_(b);
  var count = p.overdueBills.length + p.soonBills.length + p.overdue.length + p.today.length + p.stalled.length;
  if (!count) return; // nothing worth interrupting them for

  // De-dupe: don't send the same situation twice in a row. Include bill ids so a
  // newly-overdue bill always triggers a fresh alert.
  var sig = [p.overdueBills.length, p.soonBills.length, p.overdue.length, p.today.length, p.stalled.length,
    p.overdueBills.concat(p.soonBills).map(function (x) { return x.id + ':' + x.due; }).join(','),
    p.overdue.concat(p.today).map(function (t) { return t.id; }).join(',')].join('|');
  if (props_().getProperty('LAST_HEARTBEAT_SIG') === sig) return;

  // Bills lead — that's the user's top priority.
  var facts = [];
  if (p.overdueBills.length) facts.push('UNPAID / PAST DUE bills (they may have forgotten these): ' + p.overdueBills.slice(0, 5).map(function (x) { return x.name + ' ($' + (x.amount || 0) + ', was due ' + x.due + ')'; }).join('; '));
  if (p.soonBills.length) facts.push('bills due soon: ' + p.soonBills.slice(0, 5).map(function (x) { return x.name + ' ($' + (x.amount || 0) + ', due ' + x.due + ')'; }).join('; '));
  if (p.overdue.length) facts.push(p.overdue.length + ' overdue task(s): ' + p.overdue.slice(0, 5).map(function (t) { return t.title; }).join('; '));
  if (p.today.length) facts.push(p.today.length + ' due today: ' + p.today.slice(0, 5).map(function (t) { return t.title; }).join('; '));
  if (p.stalled.length) facts.push(p.stalled.length + ' stalled task(s): ' + p.stalled.slice(0, 3).map(function (t) { return t.title; }).join('; '));

  var mem = (b.memory || []).map(function (m) { return '- ' + m.text; }).join('\n') || '(none)';
  var text;
  try {
    var data = callAnthropic_(
      'You are Ledger, a warm personal assistant sending a brief proactive check-in over text. Bills are the user\'s top priority: if any bill is past due, LEAD with a direct but kind heads-up that they may have forgotten to pay it. Then briefly note anything else pressing. Write 1–3 short, natural sentences — no lists, no markdown, no greeting fluff. You may reference what you know about them. What you know:\n' + mem,
      [{ role: 'user', content: "Here's what needs attention right now:\n" + facts.join('\n') + "\n\nWrite the check-in message." }],
      null
    );
    text = (data.content || []).filter(function (x) { return x.type === 'text'; }).map(function (x) { return x.text; }).join('').trim();
  } catch (err) {
    text = 'Heads up: ' + facts.join(' · '); // fall back to the plain facts if the model call fails
  }
  if (!text) text = 'Heads up: ' + facts.join(' · ');

  sendTelegram_(owner, text);
  props_().setProperty('LAST_HEARTBEAT_SIG', sig);
}

/* ============================ SETUP HELPERS (run manually once) ============================ */

// Registers the Telegram webhook to your deployed Web App URL.
// 1) Deploy → New deployment → Web app; copy the /exec URL.
// 2) Put it in the WEB_APP_URL script property.
// 3) Run this function once.
function setWebhook() {
  var url = props_().getProperty('WEB_APP_URL');
  if (!url) throw new Error('Set the WEB_APP_URL script property to your deployed /exec URL first.');
  var r = tgApi_('setWebhook', { url: url, allowed_updates: ['message', 'edited_message'] });
  Logger.log(JSON.stringify(r));
  return r;
}
function deleteWebhook() { var r = tgApi_('deleteWebhook', {}); Logger.log(JSON.stringify(r)); return r; }
function webhookInfo() { var r = tgApi_('getWebhookInfo', {}); Logger.log(JSON.stringify(r)); return r; }

// Quick end-to-end check: confirms Firestore + Anthropic + Telegram are wired.
function testConnection() {
  var b = getBoard_();
  Logger.log('Firestore OK — ' + b.tasks.length + ' tasks, ' + b.bills.length + ' bills, ' + (b.memory || []).length + ' memories.');
  var data = callAnthropic_('Reply with exactly: OK', [{ role: 'user', content: 'ping' }], null);
  Logger.log('Anthropic OK — ' + JSON.stringify((data.content || [])[0]));
  var owner = props_().getProperty('OWNER_CHAT_ID');
  if (owner) { sendTelegram_(owner, '✅ Ledger assistant is connected and ready.'); Logger.log('Telegram OK — sent test message.'); }
  else { Logger.log('Telegram: no OWNER_CHAT_ID yet — message your bot once, then re-run.'); }
}
