// server.js — the Ledger MCP connector.
//
// Exposes tools that let Claude (with your Gmail connector alongside it) read
// and update your Ledger tracker. It talks to the SAME Firestore document the
// web app uses (ledger/main), so everything shows up live in the app.
//
// Transport: Streamable HTTP (stateless), so it works as a Claude "custom
// connector" from phone, web, and desktop.
// Auth: a secret in the URL path (/<SECRET>/mcp). Keep that URL private.

import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  readBoard, mutate, uid, findCatId, catName, findTask, findBill, cadNext, iso
} from "./board.js";

const SECRET = process.env.LEDGER_MCP_SECRET || "";
const PORT = process.env.PORT || 8080;

// ---------- small formatting helpers ----------
const ok = (text) => ({ content: [{ type: "text", text }] });
const money = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
function taskLine(board, t) {
  const sub = t.subtasks || [];
  const done = sub.filter(s => s.done).length;
  return `- [${t.id}] "${t.title}" · ${catName(board, t.cat)} · ${t.pri || "med"}` +
    `${t.due ? " · due " + t.due : ""} · ${t.done ? "DONE" : (t.status || "todo")}` +
    `${sub.length ? ` · checklist ${done}/${sub.length}` : ""}` +
    `${t.notes ? ` · notes: ${String(t.notes).replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}
function billLine(b) {
  return `- [${b.id}] "${b.name}" ${b.income ? "INCOME" : "bill"} ${money(b.amount)}` +
    ` · ${b.type === "oneoff" ? "one-time" : (b.cadence || "monthly")}` +
    `${b.due ? " · due " + b.due : ""}${b.autopay ? " · autopay" : ""}${b.paused ? " · PAUSED" : ""}`;
}

// ---------- build a fresh MCP server (stateless: one per request) ----------
function buildServer() {
  const server = new McpServer(
    { name: "ledger", version: "1.0.0" },
    { instructions:
      "Tools to read and update the user's personal Ledger task & bill tracker. " +
      "Use get_board first for context. When creating a task from an email, " +
      "summarize a clear title, and ALWAYS confirm the due date with the user " +
      "before calling add_task unless they already gave one. Dates are ISO " +
      "YYYY-MM-DD. Categories are matched by name (fuzzy)." }
  );

  server.registerTool("get_board", {
    title: "Get board summary",
    description: "Overview of the tracker: categories, open tasks, and active bills. Call this first for context.",
    inputSchema: {}
  }, async () => {
    const b = await readBoard();
    const open = b.tasks.filter(t => !t.done);
    const cats = b.cats.map(c => c.name).join(", ");
    const bills = b.bills.filter(x => !x.paused);
    const txt =
      `Categories: ${cats}\n\n` +
      `OPEN TASKS (${open.length}):\n` + (open.map(t => taskLine(b, t)).join("\n") || "(none)") +
      `\n\nACTIVE BILLS & INCOME (${bills.length}):\n` + (bills.map(billLine).join("\n") || "(none)");
    return ok(txt);
  });

  server.registerTool("list_tasks", {
    title: "List tasks",
    description: "List tasks, optionally filtered. status: todo|inprogress|blocked|done. filter: open|overdue|today|week|all.",
    inputSchema: {
      status: z.enum(["todo", "inprogress", "blocked", "done"]).optional(),
      category: z.string().optional().describe("Category name (fuzzy match)."),
      filter: z.enum(["open", "overdue", "today", "week", "all"]).optional()
    }
  }, async ({ status, category, filter }) => {
    const b = await readBoard();
    const todayIso = iso(new Date());
    let list = b.tasks;
    if (filter === "open" || !filter) list = list.filter(t => !t.done);
    if (filter === "overdue") list = list.filter(t => !t.done && t.due && t.due < todayIso);
    if (filter === "today") list = list.filter(t => !t.done && t.due === todayIso);
    if (filter === "week") {
      const wk = iso(new Date(Date.now() + 7 * 86400000));
      list = list.filter(t => !t.done && t.due && t.due >= todayIso && t.due <= wk);
    }
    if (status) list = list.filter(t => status === "done" ? t.done : (!t.done && (t.status || "todo") === status));
    if (category) { const cid = findCatId(b, category); list = list.filter(t => t.cat === cid); }
    return ok(`${list.length} task(s):\n` + (list.map(t => taskLine(b, t)).join("\n") || "(none)"));
  });

  server.registerTool("add_task", {
    title: "Add task",
    description: "Create a task in the tracker. Confirm the due date with the user first unless they gave one. due is ISO YYYY-MM-DD.",
    inputSchema: {
      title: z.string().describe("Short, clear task title."),
      category: z.string().optional().describe("Category name (fuzzy); defaults to first category."),
      priority: z.enum(["low", "med", "high", "critical"]).optional(),
      due: z.string().optional().describe("ISO date YYYY-MM-DD."),
      notes: z.string().optional().describe("Context, e.g. a short quote from the source email."),
      subtasks: z.array(z.string()).optional().describe("Checklist items.")
    }
  }, async ({ title, category, priority, due, notes, subtasks }) => {
    const res = await mutate((b) => {
      const task = {
        id: uid(), title: title || "New task",
        cat: findCatId(b, category), pri: priority || "med", due: due || "",
        repeat: "none", notes: notes || "", done: false, status: "todo",
        created: Date.now(), touched: Date.now(), pushes: 0,
        subtasks: (subtasks || []).map(s => ({ id: uid(), title: s, done: false, notes: "" }))
      };
      b.tasks.unshift(task);
      return task;
    });
    return ok(`✓ Added task "${res.title}"${res.due ? ` (due ${res.due})` : ""} in ${catName(await readBoard(), res.cat)}. id=${res.id}`);
  });

  server.registerTool("update_task", {
    title: "Update task",
    description: "Update fields on an existing task. Match by id or title (fuzzy). Only provided fields change.",
    inputSchema: {
      match: z.string().describe("Task id or (fuzzy) title to update."),
      title: z.string().optional(),
      category: z.string().optional(),
      priority: z.enum(["low", "med", "high", "critical"]).optional(),
      due: z.string().optional().describe("ISO date YYYY-MM-DD, or empty string to clear."),
      status: z.enum(["todo", "inprogress", "blocked"]).optional(),
      notes: z.string().optional(),
      done: z.boolean().optional()
    }
  }, async (a) => {
    const res = await mutate((b) => {
      const t = findTask(b, a.match);
      if (!t) return { err: `No task matching "${a.match}"` };
      if (a.title !== undefined) t.title = a.title;
      if (a.category !== undefined) t.cat = findCatId(b, a.category);
      if (a.priority !== undefined) t.pri = a.priority;
      if (a.due !== undefined) t.due = a.due;
      if (a.status !== undefined) t.status = a.status;
      if (a.notes !== undefined) t.notes = a.notes;
      if (a.done === true) { t.done = true; t.completed = Date.now(); }
      if (a.done === false) { t.done = false; t.completed = null; }
      t.touched = Date.now();
      return { title: t.title };
    });
    return ok(res.err ? "✗ " + res.err : `✓ Updated "${res.title}".`);
  });

  server.registerTool("complete_task", {
    title: "Complete task",
    description: "Mark a task done. Match by id or title (fuzzy).",
    inputSchema: { match: z.string() }
  }, async ({ match }) => {
    const res = await mutate((b) => {
      const t = findTask(b, match);
      if (!t) return { err: `No task matching "${match}"` };
      t.done = true; t.completed = Date.now(); t.touched = Date.now();
      return { title: t.title };
    });
    return ok(res.err ? "✗ " + res.err : `✓ Completed "${res.title}".`);
  });

  server.registerTool("delete_task", {
    title: "Delete task",
    description: "Permanently delete a task. Match by id or title (fuzzy). Confirm with the user first.",
    inputSchema: { match: z.string() }
  }, async ({ match }) => {
    const res = await mutate((b) => {
      const t = findTask(b, match);
      if (!t) return { err: `No task matching "${match}"` };
      b.tasks = b.tasks.filter(x => x.id !== t.id);
      return { title: t.title };
    });
    return ok(res.err ? "✗ " + res.err : `✓ Deleted "${res.title}".`);
  });

  server.registerTool("list_bills", {
    title: "List bills & income",
    description: "List bills and income items in the tracker.",
    inputSchema: { kind: z.enum(["bills", "income", "all"]).optional() }
  }, async ({ kind }) => {
    const b = await readBoard();
    let list = b.bills;
    if (kind === "bills") list = list.filter(x => !x.income);
    if (kind === "income") list = list.filter(x => x.income);
    return ok(`${list.length} item(s):\n` + (list.map(billLine).join("\n") || "(none)"));
  });

  server.registerTool("add_bill", {
    title: "Add bill or income",
    description: "Add a bill (money out) or income (set income:true). due is ISO YYYY-MM-DD. type oneoff for a one-time item; for a custom cadence set cadence:custom with interval+unit.",
    inputSchema: {
      name: z.string(),
      amount: z.number().optional(),
      income: z.boolean().optional(),
      type: z.enum(["recurring", "oneoff"]).optional(),
      cadence: z.enum(["monthly", "weekly", "biweekly", "quarterly", "annual", "custom"]).optional(),
      interval: z.number().optional().describe("For custom cadence, the number of units."),
      unit: z.enum(["day", "week", "month", "year"]).optional().describe("For custom cadence."),
      due: z.string().optional().describe("ISO date YYYY-MM-DD."),
      autopay: z.boolean().optional(),
      notes: z.string().optional()
    }
  }, async (a) => {
    const res = await mutate((b) => {
      const isCustom = a.cadence === "custom";
      const bill = {
        id: uid(), name: a.name, amount: Number(a.amount) || 0,
        income: !!a.income, type: a.type === "oneoff" ? "oneoff" : "recurring",
        cadence: a.cadence || "monthly",
        interval: isCustom ? Math.max(1, Number(a.interval) || 1) : undefined,
        unit: isCustom ? (a.unit || "month") : undefined,
        due: a.due || iso(new Date()), lead: 3, autopay: !!a.autopay,
        payUrl: "", notes: a.notes || "", paused: false, history: []
      };
      b.bills.push(bill);
      return bill;
    });
    return ok(`✓ Added ${res.income ? "income" : "bill"} "${res.name}" ${money(res.amount)}${res.due ? ` (due ${res.due})` : ""}.`);
  });

  server.registerTool("pay_bill", {
    title: "Mark bill paid / income received",
    description: "Log a payment (or receipt for income) and advance the due date. Match by id or name.",
    inputSchema: { match: z.string() }
  }, async ({ match }) => {
    const res = await mutate((b) => {
      const bl = findBill(b, match);
      if (!bl) return { err: `No bill matching "${match}"` };
      bl.history = bl.history || [];
      bl.history.unshift({ date: bl.due, paid: Date.now(), amount: bl.amount });
      bl.history = bl.history.slice(0, 24);
      if (bl.type === "oneoff") { bl.paused = true; return { name: bl.name, oneoff: true }; }
      bl.due = iso(cadNext(bl));
      return { name: bl.name, next: bl.due };
    });
    if (res.err) return ok("✗ " + res.err);
    return ok(res.oneoff ? `✓ "${res.name}" marked done (one-time).` : `✓ "${res.name}" logged — next due ${res.next}.`);
  });

  server.registerTool("add_grocery", {
    title: "Add grocery item",
    description: "Add an item to the shopping list. The app auto-files it into the right aisle from the name.",
    inputSchema: { name: z.string() }
  }, async ({ name }) => {
    await mutate((b) => { b.staples.push({ id: uid(), name, aisle: "other", done: false }); });
    return ok(`✓ Added "${name}" to the grocery list.`);
  });

  return server;
}

// ---------- HTTP wiring ----------
const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/", (_req, res) => res.type("text").send("Ledger MCP connector is running. Use the /<secret>/mcp endpoint in Claude."));
app.get("/health", (_req, res) => res.json({ ok: true }));

async function handleMcp(req, res) {
  // Auth: the secret must be the first path segment.
  if (SECRET && req.params.secret !== SECRET) {
    return res.status(404).json({ jsonrpc: "2.0", error: { code: -32001, message: "Not found" }, id: null });
  }
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error("MCP error:", e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
  }
}

// Stateless Streamable HTTP: POST carries requests; GET/DELETE not needed.
app.post("/:secret/mcp", handleMcp);
app.get("/:secret/mcp", (_req, res) =>
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST." }, id: null }));

app.listen(PORT, () => {
  console.log(`Ledger MCP listening on :${PORT}`);
  if (!SECRET) console.warn("WARNING: LEDGER_MCP_SECRET is not set — the endpoint is unauthenticated. Set it before exposing publicly.");
});
