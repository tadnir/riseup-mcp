import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { MONTH, type Budget, type MatchBy, type RiseupApi, type TrackingCategory, type Transaction } from "./api.js";
import type { SessionManager } from "./session.js";

export const VERSION = "0.1.0";

const INSTRUCTIONS = [
  "Unofficial client for the user's own RiseUp (רייזאפ) cashflow, through the same API as RiseUp's web app. Unaffiliated with RiseUp.",
  "Reading: get_budget gives a month's categories with their transactions; list_transactions flattens one month into transactions, each with the category it is in; list_categories names the categories a transaction can move to.",
  "Changing: move_transaction moves one transaction (or every transaction from its merchant) to variable expenses, out of the cashflow (excluded), or into a tracking category, making the same calls RiseUp's app makes for that move; set_transaction_comment sets a transaction's note. Ask the user before moving, and say whether it applies to one transaction or the whole merchant. RiseUp rebuilds a month's budget later (overnight, as seen so far), so a move can show in reads only after that; avoid tracking categories marked hidden unless the user asks, since what moves there drops out of the cashflow.",
  "Months are cashflow months, YYYY-MM. Amounts are in Israeli shekels (ILS).",
  "When a tool says the user must sign in, call riseup_login and give the user the link it returns; the user signs in on that page. Never ask for their phone number, codes or password in the chat.",
  "Keep Hebrew names as RiseUp gives them.",
].join(" ");

const month = z.string().regex(MONTH).describe("Cashflow month, YYYY-MM.");
const transactionId = z.string().min(1).max(100).regex(/^[A-Za-z0-9_.:-]+$/).describe("transactionId from list_transactions or get_budget.");

const schemas = {
  empty: z.object({}),
  month: z.object({ month }),
  transactions: z.object({
    month,
    search: z.string().max(100).optional().describe("Only transactions whose merchant name contains this text (case-insensitive)."),
    category: z.string().max(100).optional().describe("Only transactions in this category: variable, fixed, excluded, income, or a tracking category's name."),
  }),
  move: z.object({
    month: month.describe("The cashflow month the transaction is in, YYYY-MM."),
    transactionId,
    to: z.string().min(1).max(100).describe('Where to: "variable", "excluded", or a tracking category\'s id or name from list_categories.'),
    applyTo: z.enum(["transaction", "merchant"]).default("transaction").describe("transaction: this one only. merchant: this and future transactions from the same merchant, as RiseUp's app offers."),
  }),
  comment: z.object({
    transactionId,
    comment: z.string().max(500).describe("The note; empty clears it."),
  }),
};

function inputSchema(schema: z.ZodObject<z.ZodRawShape>): Tool["inputSchema"] {
  const properties: Record<string, object> = {};
  const required: string[] = [];
  for (const [key, value] of Object.entries(schema.shape)) {
    const field = value as z.ZodTypeAny;
    let inner = field;
    while (inner instanceof z.ZodOptional || inner instanceof z.ZodDefault) inner = inner._def.innerType;
    properties[key] = {
      type: "string",
      ...(field.description ? { description: field.description } : {}),
      ...(inner instanceof z.ZodEnum ? { enum: inner.options } : {}),
    };
    if (!field.isOptional()) required.push(key);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

const TOOLS: { name: string; description: string; schema: z.ZodObject<z.ZodRawShape> }[] = [
  { name: "riseup_login", description: "Get the link where the user signs in to RiseUp (phone number, codes and two-step sign-in are done on that page, never in the chat). Returns the status when already signed in.", schema: schemas.empty },
  { name: "riseup_session_status", description: "Whether this server is signed in to RiseUp, since when, until when, and the sign-in link when it is not.", schema: schemas.empty },
  { name: "riseup_logout", description: "Sign out of RiseUp here: end the session and forget it.", schema: schemas.empty },
  { name: "get_budget", description: "One cashflow month as RiseUp's app plans it: its envelopes (fixed, variable, tracking categories, income) with planned and balanced amounts and their transactions, and the transactions excluded from the cashflow.", schema: schemas.month },
  { name: "list_transactions", description: "One cashflow month's transactions, each with the category it is in (variable, fixed, excluded, income, or a tracking category), its merchant, date and amount.", schema: schemas.transactions },
  { name: "list_categories", description: "The categories a transaction can be moved to with move_transaction: variable, excluded, and the user's tracking categories (with their ids), as of the given month.", schema: schemas.month },
  { name: "move_transaction", description: "Move a transaction to variable expenses, out of the cashflow (excluded), or into a tracking category; with applyTo=merchant, RiseUp applies it to the merchant's transactions too. Changes the user's RiseUp account. Returns where the transaction is afterwards.", schema: schemas.move },
  { name: "set_transaction_comment", description: "Set the note on a transaction in RiseUp. Changes the user's RiseUp account.", schema: schemas.comment },
];

/** Where a transaction sits in a month, in the web app's terms. */
export type Place =
  | { kind: "variable" | "variable-income" | "fixed" | "fixed-income" | "excluded-expense" | "excluded-income" | "other"; envelope?: string }
  | { kind: "tracking"; trackingCategoryId?: string; name?: string };

export interface Located {
  transaction: Transaction;
  place: Place;
}

/** Every transaction of a month with its place. */
export function locate(budget: Budget): Located[] {
  const out: Located[] = [];
  for (const envelope of budget.envelopes ?? []) {
    const income = envelope.details?.isIncome === true || envelope.type === "variableIncome";
    let place: Place;
    switch (envelope.type) {
      case "variable":
        place = { kind: "variable" };
        break;
      case "variableIncome":
        place = { kind: "variable-income" };
        break;
      case "fixed":
        place = { kind: income ? "fixed-income" : "fixed", envelope: String(envelope.details?.expense ?? "") };
        break;
      case "trackingCategory": {
        const tc = envelope.details?.trackingCategory;
        place = { kind: "tracking", trackingCategoryId: trackingId(tc), name: String(tc?.name ?? envelope.details?.expense ?? "") };
        break;
      }
      default:
        place = { kind: "other", envelope: String(envelope.type ?? "") };
    }
    for (const transaction of envelope.actuals ?? []) out.push({ transaction, place });
  }
  for (const transaction of budget.excluded ?? []) out.push({ transaction, place: { kind: transaction.isIncome ? "excluded-income" : "excluded-expense" } });
  return out;
}

export function placeLabel(place: Place): string {
  if (place.kind === "tracking") return place.name || "tracking";
  if (place.kind === "excluded-expense" || place.kind === "excluded-income") return "excluded";
  if (place.kind === "variable-income" || place.kind === "fixed-income") return "income";
  return place.kind;
}

/** A tracking category's id: _id on an envelope's category, trackingCategoryId in the month's list. */
function trackingId(tc: TrackingCategory | undefined): string {
  return String(tc?._id ?? tc?.trackingCategoryId ?? "");
}

/**
 * A month in the shape the tools read: each envelope with its planned and
 * left amounts and its transactions as list_transactions gives them. RiseUp's
 * own budget also carries every fixed envelope's full payment history, which
 * runs to most of a megabyte.
 */
export function budgetSummary(budget: Budget): Record<string, unknown> {
  const located = locate(budget);
  const placed = new Map(located.map((l) => [l.transaction, l]));
  const envelopes = (budget.envelopes ?? []).map((envelope) => {
    const tc = envelope.details?.trackingCategory;
    const name = envelope.type === "trackingCategory" ? tc?.name : envelope.details?.expense;
    const businessName = envelope.type === "fixed" ? envelope.details?.businessName : undefined;
    return {
      type: envelope.type,
      ...(name ? { name: String(name).trim() } : {}),
      ...(businessName ? { businessName: String(businessName).trim() } : {}),
      ...(envelope.type === "trackingCategory" && trackingId(tc) ? { trackingCategoryId: trackingId(tc) } : {}),
      ...(envelope.originalAmount !== undefined ? { plannedAmount: envelope.originalAmount } : {}),
      ...(envelope.balancedAmount !== undefined ? { balancedAmount: envelope.balancedAmount } : {}),
      transactions: (envelope.actuals ?? []).map((t) => summary(placed.get(t)!)),
    };
  });
  return {
    month: budget.budgetDate,
    envelopes,
    excluded: located.filter((l) => l.place.kind === "excluded-expense" || l.place.kind === "excluded-income").map(summary),
  };
}

export interface TrackingOption {
  trackingCategoryId: string;
  name: string;
  /** Hidden in the user's RiseUp: it has no envelope, so what moves in drops out of the cashflow. */
  hidden?: true;
}

/** The month's tracking categories, from its envelopes and RiseUp's list of them. */
export function trackingCategories(budget: Budget): TrackingOption[] {
  const found = new Map<string, string>();
  for (const envelope of budget.envelopes ?? []) {
    if (envelope.type !== "trackingCategory") continue;
    const tc = envelope.details?.trackingCategory;
    const id = trackingId(tc);
    if (id) found.set(id, String(tc?.name ?? ""));
  }
  for (const tc of budget.trackingCategoryMetadata ?? []) {
    const id = trackingId(tc);
    if (id && !found.has(id)) found.set(id, String(tc.name ?? ""));
  }
  // RiseUp's own hidden ones, such as __saving-hidden-category__, are not for moving into.
  const hidden = new Set((budget.trackingCategoryMetadata ?? []).filter((tc) => tc.display === "hide").map(trackingId));
  return [...found]
    .filter(([, name]) => !/^__.*__$/.test(name))
    .map(([trackingCategoryId, name]) => ({ trackingCategoryId, name, ...(hidden.has(trackingCategoryId) ? { hidden: true as const } : {}) }));
}

/** The expense label RiseUp's app sends for a move to variable. */
export const VARIABLE_EXPENSE = "משתנות";
export const VARIABLE_INCOME = "הכנסות משתנות";

/**
 * Makes the calls RiseUp's web app makes to move a transaction, in the order
 * its "move transaction" step picks them (by where the transaction is and
 * where it goes).
 */
export async function move(api: RiseupApi, located: Located, to: { kind: "variable" | "excluded" } | { kind: "tracking"; trackingCategoryId: string }, applyTo: MatchBy): Promise<string> {
  const { transaction, place } = located;
  const id = String(transaction.transactionId ?? "");
  const businessName = String(transaction.businessName ?? "");
  const income = transaction.isIncome === true || place.kind === "variable-income" || place.kind === "fixed-income" || place.kind === "excluded-income";
  const value = applyTo === "businessName" ? businessName : id;
  if (applyTo === "businessName" && !businessName) throw new Error("This transaction has no merchant name to apply the move to.");

  if (to.kind === "tracking") {
    if (income) throw new Error("Tracking categories are for expenses only.");
    if (place.kind === "tracking" && place.trackingCategoryId === to.trackingCategoryId) throw new Error("The transaction is already in that tracking category.");
    await api.addToTrackingCategory(to.trackingCategoryId, applyTo, value);
    return "tracking-categories-predicates";
  }
  if (to.kind === "excluded") {
    if (place.kind === "excluded-expense" || place.kind === "excluded-income") throw new Error("The transaction is already excluded from the cashflow.");
    await api.setBudgetCategory(id, "excluded");
    return "budget-category excluded";
  }
  // To variable (expense or income).
  if (place.kind === "variable" || place.kind === "variable-income") throw new Error("The transaction is already in variable.");
  if (place.kind === "fixed") {
    await api.unlinkFromFixed(id);
    return "unlink-transaction-from-sequence";
  }
  if (income) {
    await api.setBudgetCategory(id, "variable");
    return "budget-category variable";
  }
  if (place.kind === "tracking") {
    await api.removeFromTracking(applyTo, value);
    return "tracking-categories-blacklist-predicates";
  }
  if (place.kind === "excluded-expense") {
    await api.setBudgetCategory(id, "variable");
    return "budget-category variable";
  }
  await api.saveEnrichment({ transactionId: id, businessName }, applyTo, VARIABLE_EXPENSE);
  return "save-enrichment";
}

function summary(l: Located): Record<string, unknown> {
  const t = l.transaction;
  const pick = (...keys: string[]) => Object.fromEntries(keys.filter((k) => t[k] !== undefined && t[k] !== null).map((k) => [k, t[k]]));
  return {
    category: placeLabel(l.place),
    ...(l.place.kind === "tracking" && l.place.trackingCategoryId ? { trackingCategoryId: l.place.trackingCategoryId } : {}),
    ...pick("transactionId", "transactionDate", "billingDate", "businessName", "isIncome", "billingAmount", "incomeAmount", "originalAmount", "expense", "accountNickname", "source", "sourceType", "isInstallment", "paymentNumber", "totalNumberOfPayments", "customerComment", "comment"),
  };
}

export function filterTransactions(all: Located[], args: { search?: string | undefined; category?: string | undefined }): Located[] {
  const search = args.search?.trim().toLowerCase();
  const category = args.category?.trim().toLowerCase();
  return all
    .filter((l) => !search || String(l.transaction.businessName ?? "").toLowerCase().includes(search))
    .filter((l) => !category || placeLabel(l.place).toLowerCase() === category)
    .sort((a, b) => String(b.transaction.transactionDate ?? "").localeCompare(String(a.transaction.transactionDate ?? "")));
}

export function createMcpServer(session: SessionManager): Server {
  const api = session.api;
  const server = new Server({ name: "riseup-mcp", version: VERSION }, { instructions: INSTRUCTIONS, capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: inputSchema(t.schema) })),
  }));

  async function find(monthValue: string, id: string): Promise<{ budget: Budget; located: Located }> {
    const budget = await api.budget(monthValue);
    const located = locate(budget).find((l) => String(l.transaction.transactionId) === id);
    if (!located) throw new Error(`No transaction ${id} in ${monthValue}. Use list_transactions for that month.`);
    return { budget, located };
  }

  async function call(name: string, raw: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "riseup_login": {
        const status = await session.status();
        if (status.state === "signed_in") return { ...status, message: "Already signed in." };
        return { ...status, message: `Ask the user to open ${status.signInUrl} and sign in there, then try the request again.` };
      }
      case "riseup_session_status":
        return session.status();
      case "riseup_logout":
        if (session.keeper.status().state === "signed_in") await api.logout().catch(() => undefined);
        await session.keeper.signOut();
        return { state: "signed_out", message: "Signed out; the saved session is gone." };
      case "get_budget": {
        const args = schemas.month.parse(raw);
        return budgetSummary(await api.budget(args.month));
      }
      case "list_transactions": {
        const args = schemas.transactions.parse(raw);
        const found = filterTransactions(locate(await api.budget(args.month)), args);
        return { month: args.month, count: found.length, transactions: found.map(summary) };
      }
      case "list_categories": {
        const args = schemas.month.parse(raw);
        return {
          month: args.month,
          categories: [
            { to: "variable", description: "Variable (day-to-day) expenses, or variable income for an income." },
            { to: "excluded", description: "Out of the cashflow: a one-off RiseUp should not count." },
            ...trackingCategories(await api.budget(args.month)).map((t) => ({
              to: t.trackingCategoryId,
              name: t.name,
              description: t.hidden
                ? "A tracking category the user hid in RiseUp: a transaction moved here drops out of the cashflow until they show it again."
                : "A tracking category, for expenses.",
              ...(t.hidden ? { hidden: true } : {}),
            })),
          ],
        };
      }
      case "move_transaction": {
        const args = schemas.move.parse(raw);
        const { budget, located } = await find(args.month, args.transactionId);
        let to: Parameters<typeof move>[2];
        if (args.to === "variable" || args.to === "excluded") to = { kind: args.to };
        else {
          const options = trackingCategories(budget);
          const match = options.find((o) => o.trackingCategoryId === args.to) ?? options.find((o) => o.name === args.to);
          if (!match) throw new Error(`No tracking category ${JSON.stringify(args.to)} in ${args.month}. Use list_categories.`);
          to = { kind: "tracking", trackingCategoryId: match.trackingCategoryId };
        }
        const before = placeLabel(located.place);
        const via = await move(api, located, to, args.applyTo === "merchant" ? "businessName" : "transactionId");
        const after = locate(await api.budget(args.month)).find((l) => String(l.transaction.transactionId) === args.transactionId);
        return {
          moved: true,
          from: before,
          now: after ? summary(after) : "not in this month any more",
          appliedTo: args.applyTo === "merchant" ? `every transaction from ${String(located.transaction.businessName ?? "")}` : "this transaction",
          via,
        };
      }
      case "set_transaction_comment": {
        const args = schemas.comment.parse(raw);
        await api.setTransactionComment(args.transactionId, args.comment);
        return { saved: true };
      }
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const result = await call(request.params.name, request.params.arguments ?? {});
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { isError: true, content: [{ type: "text", text: err instanceof Error ? err.message : "tool failed" }] };
    }
  });

  return server;
}
