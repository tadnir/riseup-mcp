import type { Fetch } from "../src/api.js";
import type { Cookie } from "../src/cookies.js";
import type { LoginBrowser } from "../src/login.js";
import type { SavedSession, SessionStore } from "../src/store.js";

export function memoryStore(initial?: SavedSession): SessionStore & { saved?: SavedSession } {
  const store = {
    saved: initial,
    async load() {
      return store.saved;
    },
    async save(s: SavedSession) {
      store.saved = s;
    },
    async clear() {
      store.saved = undefined;
    },
  };
  return store;
}

export interface Call {
  url: string;
  method: string;
  body?: string;
  headers: Record<string, string>;
}

/** A fetch that answers from a route table and records every call. */
export function fakeFetch(routes: (call: Call) => Response | undefined): Fetch & { calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : undefined,
      headers: (init?.headers as Record<string, string>) ?? {},
    };
    calls.push(call);
    return routes(call) ?? new Response("not found", { status: 404 });
  }) as Fetch & { calls: Call[] };
  f.calls = calls;
  return f;
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export interface FakeBrowser extends LoginBrowser {
  requests: { method: string; path: string; body?: unknown }[];
  clicks: [number, number][];
  typed: string[];
  pressed: string[];
  opened: string[];
  closed: boolean;
  /** Finishes the provider's pages: the browser counts as signed in from now on. */
  finishSecondFactor(): void;
}

/**
 * RiseUp's site, answering generate-code and authenticate; the right code is
 * 123456. With secondFactor, the code leaves the browser on the provider's
 * pages until finishSecondFactor().
 */
export function fakeBrowser(options: { secondFactor?: boolean; cookies?: Cookie[] } = {}): FakeBrowser {
  let signedIn = false;
  const browser: FakeBrowser = {
    requests: [],
    clicks: [],
    typed: [],
    pressed: [],
    opened: [],
    closed: false,
    finishSecondFactor() {
      signedIn = true;
    },
    async request(method, path, body) {
      browser.requests.push({ method, path, ...(body !== undefined ? { body } : {}) });
      if (path === "/api/no-auth/login/generate-code") return { status: 200, text: "" };
      if (path === "/api/no-auth/login/authenticate") {
        const ok = (body as { code?: string }).code === "123456";
        if (ok && !options.secondFactor) signedIn = true;
        return ok ? { status: 200, text: "{}" } : { status: 400, text: '{"error":"wrong code"}' };
      }
      if (path === "/api/partial-auth/is2faRequired") return { status: 200, text: JSON.stringify({ required: !!options.secondFactor }) };
      return { status: 404, text: "" };
    },
    async open(path) {
      browser.opened.push(path);
    },
    async signedIn() {
      return signedIn;
    },
    async screen() {
      return new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    },
    async click(x, y) {
      browser.clicks.push([x, y]);
    },
    async type(text) {
      browser.typed.push(text);
    },
    async press(key) {
      browser.pressed.push(key);
    },
    location() {
      return "login.example";
    },
    userAgent() {
      return "ExampleBrowser/1.0";
    },
    async cookies() {
      return options.cookies ?? [{ name: "session", value: "s1" }];
    },
    async close() {
      browser.closed = true;
    },
  };
  return browser;
}
