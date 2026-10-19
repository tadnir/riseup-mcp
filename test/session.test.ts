import { afterEach, describe, expect, test } from "vitest";
import { request } from "node:http";
import type { Budget } from "../src/api.js";
import { normalizePhone } from "../src/login.js";
import { SessionManager } from "../src/session.js";
import { createMcpServer, filterTransactions, locate, trackingCategories } from "../src/server.js";
import { fakeBrowser, fakeFetch, json, memoryStore, type FakeBrowser } from "./helpers.js";

/** A made-up month in the shape of RiseUp's budget answer. */
function budget(): Budget {
  return {
    budgetDate: "2026-05",
    envelopes: [
      { id: "e1", type: "variable", details: { expense: "משתנות" }, actuals: [{ transactionId: "t1", businessName: "Example Cafe", transactionDate: "2026-05-03", billingAmount: 42, isIncome: false, expense: "אוכל בחוץ" }] },
      { id: "e2", type: "fixed", details: { expense: "שכירות", isIncome: false }, actuals: [{ transactionId: "t2", businessName: "Example Landlord", transactionDate: "2026-05-01", billingAmount: 5000, isIncome: false }] },
      { id: "e3", type: "trackingCategory", details: { trackingCategory: { id: "tc1", name: "Eating out" } }, actuals: [{ transactionId: "t3", businessName: "Example Diner", transactionDate: "2026-05-10", billingAmount: 80, isIncome: false }] },
      { id: "e4", type: "variableIncome", actuals: [{ transactionId: "t4", businessName: "Example Client", transactionDate: "2026-05-15", incomeAmount: 900, isIncome: true }] },
    ],
    excluded: [{ transactionId: "t5", businessName: "Example Store", transactionDate: "2026-05-20", billingAmount: 300, isIncome: false }],
    trackingCategoryMetadata: [{ id: "tc2", name: "Groceries" }],
  };
}

function world() {
  const data = budget();
  const f = fakeFetch((call) => {
    if (call.headers.cookie !== "session=s1") return json({ error: "unauthorized" }, 401);
    if (call.headers["riseup-platform"] !== "WEB") return json({ error: "platform" }, 400);
    const path = new URL(call.url).pathname;
    if (path === "/api/logged-in/") return json({}, 200, { "set-cookie": "session=s1; Path=/; HttpOnly" });
    if (path === "/api/budget/2026-05") return json(data);
    if (call.method === "POST" && path.startsWith("/api/")) {
      // Moves land where RiseUp would put them, so the tool can report the result.
      const body = JSON.parse(call.body ?? "{}") as Record<string, string>;
      const all = locate(data);
      const take = (key: string) => {
        const id = all.find((l) => l.transaction.transactionId === key || l.transaction.businessName === key)!.transaction.transactionId;
        for (const e of data.envelopes ?? []) e.actuals = (e.actuals ?? []).filter((t) => t.transactionId !== id);
        data.excluded = (data.excluded ?? []).filter((t) => t.transactionId !== id);
        return all.find((l) => l.transaction.transactionId === id)!.transaction;
      };
      const into = (type: string, t: unknown) => data.envelopes!.find((e) => e.type === type)!.actuals!.push(t as never);
      if (path === "/api/investigator/answers/budget-category" && body.budgetCategory === "excluded") {
        const t = take(body.transactionId!);
        data.excluded!.push(t);
      }
      else if (path === "/api/investigator/answers/budget-category") into("variable", take(body.transactionId!));
      else if (path === "/api/tracking-categories-predicates") into("trackingCategory", take(body.value!));
      else if (path === "/api/tracking-categories-blacklist-predicates") into("variable", take(body.value!));
      else if (path === "/api/prediction-update/unlink-transaction-from-sequence") into("variable", take(body.transactionId!));
      return json({});
    }
    return undefined;
  });
  return f;
}

function http(port: number, method: string, path: string, body?: string, host = `127.0.0.1:${port}`, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { host, "content-type": "application/x-www-form-urlencoded", ...extra } }, (res) => {
      let t = "";
      res.on("data", (c) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode!, text: t }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

let session: SessionManager | undefined;
afterEach(() => session?.stop());

async function signedOutSession(secondFactor = false) {
  const browsers: FakeBrowser[] = [];
  const f = world();
  session = new SessionManager({
    store: memoryStore(),
    fetch: f,
    port: 0,
    stepWaitMs: 50,
    watchMs: 10,
    openBrowser: async () => {
      const b = fakeBrowser({ secondFactor });
      browsers.push(b);
      return b;
    },
  });
  await session.start();
  const url = await session.signInUrl();
  return { f, session, browsers, port: Number(new URL(url).port) };
}

const csrfOf = (html: string) => /name="csrf" value="([0-9a-f]+)"/.exec(html)![1]!;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

describe("sign-in page", () => {
  test("phone, then code, then signed in", async () => {
    const { session, browsers, port } = await signedOutSession();
    const first = await http(port, "GET", "/");
    expect(first.text).toContain("Send code");
    const csrf = csrfOf(first.text);

    expect((await http(port, "POST", "/start", `csrf=${csrf}&phone=%2B972-50-000-0000&via=whatsapp&length=1d`)).status).toBe(303);
    const browser = browsers[0]!;
    expect(browser.requests[0]).toEqual({ method: "POST", path: "/api/no-auth/login/generate-code", body: { phoneNumber: "0500000000", force: false, sendPlatform: "whatsapp" } });
    expect((await http(port, "GET", "/")).text).toContain("Enter the code");

    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=000000`)).status).toBe(303);
    expect((await http(port, "GET", "/")).text).toContain("did not accept the code");
    expect((await http(port, "POST", "/code", `csrf=${csrf}&code=123456`)).status).toBe(303);
    expect(browser.requests.at(-1)).toEqual({ method: "POST", path: "/api/no-auth/login/authenticate", body: { phoneNumber: "0500000000", code: "123456" } });
    expect(browser.closed).toBe(true);
    expect(session.keeper.status().state).toBe("signed_in");

    const status = (await http(port, "GET", "/")).text;
    expect(status).toContain("Signed in to RiseUp");
    expect(status).toContain("Sign in again");
  });

  test("two-step sign-in: the provider's page is shown live, input reaches it, and it finishes by itself", async () => {
    const { session, browsers, port } = await signedOutSession(true);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    await http(port, "POST", "/start", `csrf=${csrf}&phone=0500000000&length=1d`);
    await http(port, "POST", "/code", `csrf=${csrf}&code=123456`);
    const browser = browsers[0]!;
    expect(browser.opened).toEqual(["/"]);

    const page = await http(port, "GET", "/");
    expect(page.text).toContain("Finish signing in");
    expect(page.text).toContain("login.example");
    expect(page.text).toContain('src="screen.js"');
    expect((await http(port, "GET", "/screen.js")).text).toContain("x-screen-live");
    expect((await http(port, "GET", "/screen.png")).status).toBe(200);

    expect((await http(port, "POST", "/click", `csrf=${csrf}&p.x=10&p.y=20`, undefined, { "x-screen-live": "1" })).status).toBe(204);
    expect((await http(port, "POST", "/type", `csrf=${csrf}&text=someone%40example.com`, undefined, { "x-screen-live": "1" })).status).toBe(204);
    expect((await http(port, "POST", "/key", `csrf=${csrf}&key=Enter`)).status).toBe(303);
    expect((await http(port, "POST", "/key", `csrf=${csrf}&key=F12`)).status).toBe(303);
    expect(browser.clicks).toEqual([[10, 20]]);
    expect(browser.typed).toEqual(["someone@example.com"]);
    expect(browser.pressed).toEqual(["Enter"]);
    expect(session.keeper.status().state).toBe("signed_out");

    browser.finishSecondFactor();
    await until(() => session.keeper.status().state === "signed_in");
    expect(session.keeper.status().state).toBe("signed_in");
    expect(browser.closed).toBe(true);
    expect((await http(port, "GET", "/screen.png")).status).toBe(404);
    expect((await http(port, "POST", "/click", `csrf=${csrf}&p.x=1&p.y=1`, undefined, { "x-screen-live": "1" })).status).toBe(410);
  });

  test("other hosts, forms without the token and bad input are refused", async () => {
    const { port, browsers } = await signedOutSession();
    expect((await http(port, "GET", "/", undefined, "attacker.example")).status).toBe(421);
    expect((await http(port, "POST", "/start", "csrf=nope&phone=0500000000")).status).toBe(400);
    const csrf = csrfOf((await http(port, "GET", "/")).text);
    expect((await http(port, "POST", "/start", `csrf=${csrf}&phone=12345&length=1d`)).status).toBe(400);
    expect(browsers).toHaveLength(0);
  });
});

describe("tools", () => {
  async function callTool(server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) {
    const handler = (server as unknown as { _requestHandlers: Map<string, (r: unknown, x: unknown) => Promise<unknown>> })._requestHandlers.get("tools/call")!;
    return (await handler({ method: "tools/call", params: { name, arguments: args } }, {})) as { isError?: boolean; content: { text: string }[] };
  }
  const result = async (server: ReturnType<typeof createMcpServer>, name: string, args: Record<string, unknown> = {}) => {
    const r = await callTool(server, name, args);
    if (r.isError) throw new Error(r.content[0]!.text);
    return JSON.parse(r.content[0]!.text);
  };

  async function signedIn() {
    const s = await signedOutSession();
    await s.session.keeper.signedIn([{ name: "session", value: "s1" }], 3_600_000);
    return { ...s, server: createMcpServer(s.session) };
  }

  test("signed out: data tools answer with the sign-in link", async () => {
    const { session, port } = await signedOutSession();
    const r = await callTool(createMcpServer(session), "list_transactions", { month: "2026-05" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain(`http://localhost:${port}/`);
    expect(r.content[0]!.text).toContain("Never ask the user");
  });

  test("transactions come with their category, filtered and newest first", async () => {
    const { server } = await signedIn();
    const all = await result(server, "list_transactions", { month: "2026-05" });
    expect(all.transactions.map((t: { transactionId: string; category: string }) => [t.transactionId, t.category])).toEqual([
      ["t5", "excluded"],
      ["t4", "income"],
      ["t3", "Eating out"],
      ["t1", "variable"],
      ["t2", "fixed"],
    ]);
    expect((await result(server, "list_transactions", { month: "2026-05", search: "cafe" })).count).toBe(1);
    expect((await result(server, "list_transactions", { month: "2026-05", category: "excluded" })).transactions[0].transactionId).toBe("t5");
    const categories = await result(server, "list_categories", { month: "2026-05" });
    expect(categories.categories.map((c: { to: string }) => c.to)).toEqual(["variable", "excluded", "tc1", "tc2"]);
  });

  test("moves make the web app's call for each case and report where the transaction is", async () => {
    const { server, f } = await signedIn();
    const lastPost = () => {
      const c = f.calls.filter((x) => x.method === "POST").at(-1)!;
      return [new URL(c.url).pathname, JSON.parse(c.body!)];
    };

    let r = await result(server, "move_transaction", { month: "2026-05", transactionId: "t1", to: "Groceries" });
    expect(lastPost()).toEqual(["/api/tracking-categories-predicates", { trackingCategoryId: "tc2", matchBy: "transactionId", value: "t1" }]);
    expect(r).toMatchObject({ moved: true, from: "variable", now: { category: "Eating out" } });

    r = await result(server, "move_transaction", { month: "2026-05", transactionId: "t3", to: "variable", applyTo: "merchant" });
    expect(lastPost()).toEqual(["/api/tracking-categories-blacklist-predicates", { matchBy: "businessName", value: "Example Diner" }]);
    expect(r.appliedTo).toBe("every transaction from Example Diner");

    await result(server, "move_transaction", { month: "2026-05", transactionId: "t2", to: "variable" });
    expect(lastPost()).toEqual(["/api/prediction-update/unlink-transaction-from-sequence", { transactionId: "t2" }]);

    await result(server, "move_transaction", { month: "2026-05", transactionId: "t5", to: "variable" });
    expect(lastPost()).toEqual(["/api/investigator/answers/budget-category", { transactionId: "t5", budgetCategory: "variable" }]);

    r = await result(server, "move_transaction", { month: "2026-05", transactionId: "t5", to: "excluded" });
    expect(lastPost()).toEqual(["/api/investigator/answers/budget-category", { transactionId: "t5", budgetCategory: "excluded" }]);
    expect(r.now.category).toBe("excluded");

    const refused = await callTool(server, "move_transaction", { month: "2026-05", transactionId: "t4", to: "tc1" });
    expect(refused.isError).toBe(true);
    expect((await callTool(server, "move_transaction", { month: "2026-05", transactionId: "t9", to: "variable" })).isError).toBe(true);
    expect((await callTool(server, "move_transaction", { month: "2026-05", transactionId: "t1", to: "Nope" })).isError).toBe(true);

    await result(server, "set_transaction_comment", { transactionId: "t1", comment: "a note" });
    expect(lastPost()).toEqual(["/api/enrichment-update/save-comments", { transactionId: "t1", comment: "a note" }]);
  });

  test("a refused cookie ends the session and the tools ask for a sign-in", async () => {
    const { session } = await signedOutSession();
    await session.keeper.signedIn([{ name: "session", value: "stale" }], 3_600_000);
    const r = await callTool(createMcpServer(session), "get_budget", { month: "2026-05" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Not signed in");
    expect(session.keeper.status().state).toBe("expired");
  });

  test("the keep-alive check uses the session", async () => {
    const { session } = await signedIn();
    await session.keeper.tick();
    expect(session.keeper.status()).toMatchObject({ state: "signed_in" });
    expect(session.keeper.status().lastError).toBeUndefined();
  });

  test("bad months and ids never reach a URL", async () => {
    const { server, f } = await signedIn();
    const before = f.calls.length;
    expect((await callTool(server, "get_budget", { month: "../x" })).isError).toBe(true);
    expect((await callTool(server, "move_transaction", { month: "2026-05", transactionId: "../x", to: "variable" })).isError).toBe(true);
    expect(f.calls.length).toBe(before);
  });
});

describe("helpers", () => {
  test("phone numbers are taken as RiseUp's page takes them", () => {
    expect(normalizePhone("050-000-0000")).toBe("0500000000");
    expect(normalizePhone("+972 50 000 0000")).toBe("0500000000");
    expect(normalizePhone("972500000000")).toBe("0500000000");
    expect(normalizePhone("031234567")).toBeUndefined();
  });

  test("tracking categories come from the envelopes and RiseUp's list, once each", () => {
    expect(trackingCategories(budget())).toEqual([
      { trackingCategoryId: "tc1", name: "Eating out" },
      { trackingCategoryId: "tc2", name: "Groceries" },
    ]);
  });

  test("filters", () => {
    const all = locate(budget());
    expect(filterTransactions(all, { category: "fixed" }).map((l) => l.transaction.transactionId)).toEqual(["t2"]);
    expect(filterTransactions(all, { search: "EXAMPLE C" }).map((l) => l.transaction.transactionId)).toEqual(["t4", "t1"]);
  });
});
