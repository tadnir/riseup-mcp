/**
 * The RiseUp web app's API (input.riseup.co.il/api), the one its own pages
 * call. Unlike RiseUp's public "external" API, which is read-only, this one
 * also moves transactions between categories.
 *
 * Every call carries the session's cookies and the RISEUP-PLATFORM header the
 * web app adds to each request. Signed out, the API answers 401 or 403.
 */
import type { CookieJar } from "./cookies.js";

export type Fetch = (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>;

export const SITE_ORIGIN = process.env.RISEUP_SITE_ORIGIN || "https://input.riseup.co.il";

const HEADERS: Record<string, string> = {
  accept: "application/json, text/plain, */*",
  "accept-language": "he,en;q=0.9",
  "riseup-platform": "WEB",
  origin: SITE_ORIGIN,
  referer: `${SITE_ORIGIN}/`,
};

export class RiseupApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "RiseupApiError";
  }
}

/** RiseUp refused the cookies: the session is over. */
export class Unauthorized extends RiseupApiError {
  constructor() {
    super("RiseUp ended the session.", 401);
    this.name = "Unauthorized";
  }
}

/** A cashflow month as the web app names it, e.g. 2026-05. */
export const MONTH = /^\d{4}-\d{2}$/;

/** What a transaction is matched by when it is moved: this one only, or every one from its merchant. */
export type MatchBy = "transactionId" | "businessName";

export class RiseupApi {
  readonly #jar: () => Promise<CookieJar>;
  readonly #changed: () => Promise<void>;
  readonly #fetch: Fetch;

  /**
   * jar returns the live session's cookies (throwing when there is none);
   * changed is called after the API set new ones, so they can be saved.
   */
  constructor(jar: () => Promise<CookieJar>, changed: () => Promise<void>, f: Fetch = fetch) {
    this.#jar = jar;
    this.#changed = changed;
    this.#fetch = f;
  }

  /** Answers 200 while the session lives; also counts as activity. */
  async ping(): Promise<void> {
    await this.#request("/api/logged-in/", { method: "GET" });
  }

  async logout(): Promise<void> {
    await this.#request("/api/no-auth/logout", { method: "POST" });
  }

  /** One cashflow month: its envelopes (categories) with their transactions, and the excluded ones. */
  async budget(value: string): Promise<Budget> {
    return (await this.#json(`/api/budget/${month(value)}`)) as Budget;
  }

  /** The months that have a cashflow, as the web app lists them. */
  async budgets(): Promise<unknown> {
    return this.#json("/api/budget");
  }

  /** The customer's tracking categories (the ones with a spending goal). */
  async trackingCategories(): Promise<unknown> {
    return this.#json("/api/tracking-categories/");
  }

  // Moving a transaction: each call is the one the web app makes for that move.

  /** Into a tracking category, for this transaction or every one from its merchant. */
  async addToTrackingCategory(trackingCategoryId: string, matchBy: MatchBy, value: string): Promise<void> {
    await this.#post("/api/tracking-categories-predicates", { trackingCategoryId, matchBy, value });
  }

  /** Out of the tracking categories, back to variable expenses. */
  async removeFromTracking(matchBy: MatchBy, value: string): Promise<void> {
    await this.#post("/api/tracking-categories-blacklist-predicates", { matchBy, value });
  }

  /** Out of the cashflow (excluded), or back into variable. */
  async setBudgetCategory(transactionId: string, budgetCategory: "excluded" | "variable"): Promise<void> {
    await this.#post("/api/investigator/answers/budget-category", { transactionId, budgetCategory });
  }

  /** A fixed expense or income that is not one: unlinks it from its recurring sequence. */
  async unlinkFromFixed(transactionId: string): Promise<void> {
    await this.#post("/api/prediction-update/unlink-transaction-from-sequence", { transactionId });
  }

  /** The web app's general move: sets the transaction's (or merchant's) expense label. */
  async saveEnrichment(transaction: { transactionId: string; businessName: string }, applyTo: MatchBy, expense: string): Promise<void> {
    await this.#post("/api/enrichment-update/save-enrichment", { businessName: transaction.businessName, transactionId: transaction.transactionId, applyTo, expense });
  }

  async setTransactionComment(transactionId: string, comment: string): Promise<void> {
    await this.#post("/api/enrichment-update/save-comments", { transactionId, comment });
  }

  async #json(path: string): Promise<unknown> {
    const res = await this.#request(path, { method: "GET" });
    const text = await res.text();
    try {
      return text === "" ? null : JSON.parse(text);
    } catch {
      throw new RiseupApiError(`RiseUp answered ${path} with something other than JSON.`);
    }
  }

  async #post(path: string, body: unknown): Promise<void> {
    await this.#request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async #request(path: string, init: RequestInit): Promise<Response> {
    const jar = await this.#jar();
    const res = await this.#fetch(new URL(path, SITE_ORIGIN), {
      ...init,
      headers: { ...HEADERS, ...(init.headers as Record<string, string> | undefined), cookie: jar.header() },
    });
    if (jar.update(res)) await this.#changed();
    if (res.status === 401 || res.status === 403) throw new Unauthorized();
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      throw new RiseupApiError(`RiseUp answered HTTP ${res.status}${detail ? `: ${detail}` : ""}.`, res.status);
    }
    return res;
  }
}

function month(value: string): string {
  if (!MONTH.test(value)) throw new RiseupApiError(`Not a month (YYYY-MM): ${JSON.stringify(value)}`);
  return value;
}

/** The parts of a budget this server reads; the rest is passed through as RiseUp sends it. */
export interface Budget {
  budgetDate?: string;
  envelopes?: Envelope[];
  excluded?: Transaction[];
  trackingCategoryMetadata?: TrackingCategory[];
  [key: string]: unknown;
}

export interface Envelope {
  id?: string;
  type?: string;
  details?: Record<string, unknown> & { trackingCategory?: TrackingCategory; expense?: string; isIncome?: boolean };
  actuals?: Transaction[];
  [key: string]: unknown;
}

export interface TrackingCategory {
  /** On an envelope's category. */
  _id?: string;
  /** In the month's trackingCategoryMetadata. */
  trackingCategoryId?: string;
  name?: string;
  [key: string]: unknown;
}

export interface Transaction {
  transactionId?: string;
  businessName?: string;
  expense?: string;
  isIncome?: boolean;
  [key: string]: unknown;
}
