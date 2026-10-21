/**
 * The signed-in side of the server: one RiseUp session kept alive in this
 * process, and a small sign-in page that starts it.
 *
 * Settings (environment):
 *   RISEUP_CONFIG_DIR  where the session is saved (default ~/.config/riseup-mcp)
 *   RISEUP_LOGIN_HOST  address the sign-in page listens on (default 127.0.0.1)
 *   RISEUP_LOGIN_PORT  its port (default 8768; a free port if that one is taken)
 *   RISEUP_LOGIN_URL   the link handed out, when the page is reached through a
 *                      reverse proxy (default http://localhost:<port>/); when
 *                      set, the page starts with the server
 *   RISEUP_HEADLESS    false shows the sign-in browser's window (default true)
 *
 * The phone number, the codes and the second factor are typed on that page
 * only. The model is only ever given its link.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { RiseupApi, Unauthorized, type Fetch } from "./api.js";
import { SessionKeeper, SessionRefused, SignInRequired, type KeeperStatus } from "./keeper.js";
import { KEYS, RiseupLoginError, normalizePhone, openChromium, sendCode, verifyCode, type LoginBrowser, type OpenBrowser, type SendPlatform } from "./login.js";
import { DEFAULT_SESSION_LENGTH, PAGE_HEADERS, SCREEN_SCRIPT, SESSION_LENGTHS, browserPage, codePage, messagePage, phonePage, statusPage, workingPage } from "./pages.js";
import { fileStore, type SessionStore } from "./store.js";

const log = (line: string): void => console.error(`[riseup-mcp] ${line}`);

/** A sign-in left alone this long is dropped and its browser closed. */
const PENDING_TTL_MS = 10 * 60_000;
/** How long a form waits for RiseUp before showing a progress page. */
const STEP_WAIT_MS = 8_000;
/** How often the second-factor step asks RiseUp whether it is done. */
const WATCH_MS = 2_000;

export interface SessionStatus extends KeeperStatus {
  signInUrl?: string;
}

export interface SessionManagerOptions {
  store?: SessionStore;
  fetch?: Fetch;
  openBrowser?: OpenBrowser;
  host?: string;
  port?: number;
  url?: string;
  tickMs?: number;
  /** How long a form waits for RiseUp before showing progress. */
  stepWaitMs?: number;
  /** How often the second-factor step checks whether it is done. */
  watchMs?: number;
}

/** A sign-in in progress, in a browser on RiseUp's site. */
interface Pending {
  browser: LoginBrowser;
  phone: string;
  lengthMs: number;
  at: number;
  /** sending the code, waiting for it, checking it, or the provider's pages in the browser. */
  step: "sending" | "code" | "verifying" | "browser";
  error?: string;
  watch?: ReturnType<typeof setInterval>;
}

export class SessionManager {
  readonly keeper: SessionKeeper;
  readonly api: RiseupApi;
  readonly #openBrowser: OpenBrowser;
  readonly #stepWaitMs: number;
  readonly #watchMs: number;
  readonly #csrf = randomBytes(16).toString("hex");
  readonly #host: string;
  readonly #port: number;
  readonly #fixedUrl: string | undefined;
  #server: Promise<string> | undefined;
  #http: Server | undefined;
  #pending: Pending | undefined;
  /** Why the last sign-in failed, shown once on the sign-in page. */
  #notice: string | undefined;

  constructor(options: SessionManagerOptions = {}) {
    this.#openBrowser = options.openBrowser ?? openChromium;
    this.#stepWaitMs = options.stepWaitMs ?? STEP_WAIT_MS;
    this.#watchMs = options.watchMs ?? WATCH_MS;
    this.#host = options.host ?? (process.env.RISEUP_LOGIN_HOST || "127.0.0.1");
    this.#port = options.port ?? Number(process.env.RISEUP_LOGIN_PORT || 8768);
    this.#fixedUrl = options.url ?? (process.env.RISEUP_LOGIN_URL || undefined);
    this.keeper = new SessionKeeper({ store: options.store ?? fileStore(), ...(options.tickMs ? { tickMs: options.tickMs } : {}) });
    this.api = new RiseupApi(
      () => this.#jar(),
      () => this.keeper.cookiesChanged(),
      (input, init) => this.#apiFetch(input, init, options.fetch ?? fetch),
    );
    this.keeper.check = async () => {
      try {
        await this.api.ping();
      } catch (err) {
        if (err instanceof Unauthorized || err instanceof SignInRequired) throw new SessionRefused();
        throw err;
      }
    };
  }

  async start(): Promise<void> {
    await this.keeper.start();
    if (this.#fixedUrl) await this.signInUrl();
  }

  stop(): void {
    this.keeper.stop();
    this.#http?.close();
    void this.#dropPending();
  }

  /** Starts the sign-in page if it is not up yet and returns its link. */
  signInUrl(): Promise<string> {
    this.#server ??= this.#listen().catch((err: unknown) => {
      this.#server = undefined;
      throw err;
    });
    return this.#server;
  }

  async status(): Promise<SessionStatus> {
    const status = this.keeper.status();
    if (status.state === "signed_in") return status;
    return { ...status, signInUrl: await this.signInUrl() };
  }

  async #jar() {
    try {
      return await this.keeper.jar();
    } catch (err) {
      if (err instanceof SignInRequired) throw await this.#signInRequired();
      throw err;
    }
  }

  async #signInRequired(): Promise<SignInRequired> {
    const url = await this.signInUrl();
    return new SignInRequired(
      `Not signed in to RiseUp (the session ended, or nobody has signed in yet). ` +
        `Ask the user to open ${url} and sign in there with their mobile number, the one-time code RiseUp sends, and RiseUp's two-step sign-in if it asks for it, then try again. ` +
        `Never ask the user for these in the chat.`,
    );
  }

  /** A refused session is forgotten, and the caller is told to sign in. */
  async #apiFetch(input: URL | RequestInfo, init: RequestInit | undefined, f: Fetch): Promise<Response> {
    // As the browser that signed in: RiseUp may tie the session to it.
    const userAgent = this.keeper.userAgent();
    const res = await f(input, userAgent ? { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), "user-agent": userAgent } } : init);
    if (res.status === 401 || res.status === 403) {
      log(`RiseUp refused ${new URL(String(input instanceof Request ? input.url : input)).pathname} with HTTP ${res.status}`);
      await this.keeper.lost("RiseUp ended the session.");
      throw await this.#signInRequired();
    }
    return res;
  }

  async #listen(): Promise<string> {
    const server = createServer((req, res) => {
      this.#handle(req, res).catch((err: unknown) => {
        log(`sign-in page failed: ${err instanceof Error ? err.message : String(err)}`);
        if (!res.headersSent) page(res, 500, messagePage("Something went wrong", "Reload the page and try again."));
        else res.end();
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.#host, () => {
          server.off("error", reject);
          const address = server.address();
          resolve(typeof address === "object" && address ? address.port : port);
        });
      });
    let port: number;
    try {
      port = await bind(this.#port);
    } catch (err) {
      // Another client's copy of this server holds the port: any free one will do locally.
      if ((err as { code?: string }).code !== "EADDRINUSE" || this.#fixedUrl) throw err;
      port = await bind(0);
    }
    server.unref();
    this.#http = server;
    const url = this.#fixedUrl ?? `http://localhost:${port}/`;
    log(`sign-in page on ${this.#host}:${port}, linked as ${url}`);
    return url;
  }

  /** Only the hosts the link names: a page another site rebinds to 127.0.0.1 gets nothing. */
  #hostAllowed(req: IncomingMessage): boolean {
    const host = (req.headers.host ?? "").toLowerCase();
    const name = host.replace(/:\d+$/, "");
    if (name === "localhost" || name === "127.0.0.1" || name === "[::1]") return true;
    if (!this.#fixedUrl) return false;
    return host === new URL(this.#fixedUrl).host.toLowerCase();
  }

  #livePending(): Pending | undefined {
    if (this.#pending && Date.now() - this.#pending.at > PENDING_TTL_MS) void this.#dropPending();
    return this.#pending;
  }

  async #dropPending(): Promise<void> {
    const pending = this.#pending;
    this.#pending = undefined;
    if (pending?.watch) clearInterval(pending.watch);
    await pending?.browser.close().catch(() => undefined);
  }

  /** The browser is signed in: keep its cookies, close it. */
  async #finish(pending: Pending): Promise<void> {
    if (this.#pending !== pending) return;
    const cookies = await pending.browser.cookies();
    if (cookies.length === 0) throw new RiseupLoginError("RiseUp signed in but set no session cookie.");
    this.#pending = undefined;
    if (pending.watch) clearInterval(pending.watch);
    const userAgent = pending.browser.userAgent();
    await pending.browser.close().catch(() => undefined);
    await this.keeper.signedIn(cookies, pending.lengthMs, userAgent);
  }

  /** On the provider's pages: checks every few seconds whether RiseUp now counts the browser as signed in. */
  #watch(pending: Pending): void {
    let busy = false;
    pending.watch = setInterval(() => {
      if (busy || this.#pending !== pending) return;
      busy = true;
      pending.browser
        .signedIn()
        .then((done) => (done ? this.#finish(pending) : undefined))
        .catch((err: unknown) => {
          pending.error = err instanceof Error ? err.message : String(err);
        })
        .finally(() => (busy = false));
    }, this.#watchMs);
    pending.watch.unref?.();
  }

  /** Runs a step in the background; a form waits a little for it, then the page shows its progress. */
  async #run(pending: Pending, step: () => Promise<void>, onError: (message: string) => Promise<void>): Promise<void> {
    const task = step().catch(async (err: unknown) => {
      if (this.#pending !== pending) return;
      await onError(err instanceof RiseupLoginError ? err.message : `Something went wrong: ${err instanceof Error ? err.message : String(err)}`);
    });
    await Promise.race([task, new Promise((resolve) => setTimeout(resolve, this.#stepWaitMs).unref())]);
  }

  async #fail(message: string): Promise<void> {
    this.#notice = message;
    await this.#dropPending();
  }

  async #pendingPage(pending: Pending): Promise<string> {
    if (pending.step === "code") return codePage(this.#csrf, pending.error);
    if (pending.step === "browser") return browserPage(this.#csrf, pending.browser.location(), KEYS, pending.error);
    return workingPage(this.#csrf, pending.step === "sending" ? "Asking RiseUp for a code…" : "Checking the code…");
  }

  async #handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.#hostAllowed(req)) {
      page(res, 421, messagePage("Wrong address", "Open the sign-in link exactly as it was given."));
      return;
    }
    const path = new URL(req.url ?? "/", "http://localhost").pathname;
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, riseup: this.keeper.status().state }));
      return;
    }
    if (req.method === "GET" && path === "/") {
      const status = this.keeper.status();
      const pending = this.#livePending();
      const notice = this.#notice;
      this.#notice = undefined;
      if (pending) page(res, 200, await this.#pendingPage(pending));
      else page(res, 200, status.state === "signed_in" && !notice ? statusPage(status, this.#csrf) : phonePage(status, this.#csrf, notice));
      return;
    }
    if (req.method === "GET" && path === "/screen.js") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" }).end(SCREEN_SCRIPT);
      return;
    }
    if (req.method === "GET" && path === "/screen.png") {
      const pending = this.#livePending();
      const png = pending?.step === "browser" ? await pending.browser.screen().catch(() => undefined) : undefined;
      if (!png) res.writeHead(404, { "cache-control": "no-store" }).end();
      else res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(png);
      return;
    }
    if (req.method !== "POST" || !["/start", "/code", "/click", "/type", "/key", "/cancel", "/sign-out"].includes(path)) {
      res.writeHead(404).end();
      return;
    }
    const form = new URLSearchParams(await readBody(req));
    if (form.get("csrf") !== this.#csrf) {
      page(res, 400, messagePage("Form expired", "Reload the page and try again."));
      return;
    }
    if (path === "/cancel") {
      await this.#dropPending();
    } else if (path === "/sign-out") {
      await this.#dropPending();
      await this.api.logout().catch(() => undefined);
      await this.keeper.signOut();
    } else if (path === "/start") {
      const phone = normalizePhone(form.get("phone") ?? "");
      const via: SendPlatform = form.get("via") === "whatsapp" ? "whatsapp" : "sms";
      const length = SESSION_LENGTHS[form.get("length") ?? DEFAULT_SESSION_LENGTH];
      if (!phone || !length) {
        page(res, 400, phonePage(this.keeper.status(), this.#csrf, "Enter the account's Israeli mobile number (05X-XXXXXXX) and pick a length."));
        return;
      }
      await this.#dropPending();
      let browser: LoginBrowser;
      try {
        browser = await this.#openBrowser();
      } catch (err) {
        if (!(err instanceof RiseupLoginError)) throw err;
        page(res, 200, phonePage(this.keeper.status(), this.#csrf, err.message));
        return;
      }
      const pending: Pending = { browser, phone, lengthMs: length[1], at: Date.now(), step: "sending" };
      this.#pending = pending;
      await this.#run(
        pending,
        async () => {
          await sendCode(browser, phone, via);
          pending.step = "code";
          pending.at = Date.now();
        },
        (message) => this.#fail(message),
      );
    } else if (path === "/code") {
      const pending = this.#livePending();
      if (!pending || pending.step !== "code") {
        if (!pending) this.#notice = "That sign-in timed out. Start again.";
        res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
        return;
      }
      const code = (form.get("code") ?? "").trim();
      pending.step = "verifying";
      delete pending.error;
      await this.#run(
        pending,
        async () => {
          const next = await verifyCode(pending.browser, pending.phone, code);
          if (this.#pending !== pending) return;
          if (next === "signed_in") {
            await this.#finish(pending);
            return;
          }
          pending.step = "browser";
          pending.at = Date.now();
          this.#watch(pending);
        },
        async (message) => {
          pending.step = "code";
          pending.error = message;
        },
      );
    } else {
      // The provider's pages: a click, typing or a key, passed on to the browser.
      const pending = this.#livePending();
      const live = req.headers["x-screen-live"] === "1";
      if (pending?.step === "browser") {
        pending.at = Date.now();
        if (path === "/click") {
          const x = Number(form.get("p.x"));
          const y = Number(form.get("p.y"));
          if (Number.isFinite(x) && Number.isFinite(y)) await pending.browser.click(x, y);
        } else if (path === "/type") {
          const text = form.get("text") ?? "";
          if (text.length > 0 && text.length <= 200) await pending.browser.type(text);
        } else {
          const key = form.get("key") ?? "";
          if ((KEYS as readonly string[]).includes(key)) await pending.browser.press(key);
        }
        // Give the page a moment to react before the next picture.
        if (!live) await new Promise((resolve) => setTimeout(resolve, Math.min(1_500, this.#stepWaitMs)).unref());
      }
      if (live) {
        res.writeHead(pending?.step === "browser" ? 204 : 410, { "cache-control": "no-store" }).end();
        return;
      }
    }
    res.writeHead(303, { location: "./", "cache-control": "no-store" }).end();
  }
}

function page(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, PAGE_HEADERS).end(html);
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) {
    body += String(chunk);
    if (body.length > 16 * 1024) throw new Error("form too large");
  }
  return body;
}
