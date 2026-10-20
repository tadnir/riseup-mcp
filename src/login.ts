/**
 * Signing in to RiseUp: the mobile number on the account gets a one-time code
 * by SMS (or WhatsApp), and the code signs in. Accounts with two-factor
 * sign-in then go through RiseUp's identity provider (Auth0 or Descope) on its
 * own pages, which ask for more (an email, a password, another code).
 *
 * Every step runs inside a real browser on RiseUp's site (Playwright's
 * Chromium): the code steps as requests from the web app's own page, the
 * second factor on the provider's pages themselves. This server knows nothing
 * about those pages: its sign-in page shows the browser's screen and passes
 * the person's clicks and typing on, until RiseUp says the session is signed
 * in. Nothing is typed automatically. The phone number, the codes and
 * anything typed for the second factor are only ever sent to RiseUp and its
 * provider.
 */
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SITE_ORIGIN } from "./api.js";
import type { Cookie } from "./cookies.js";
import { configDir } from "./store.js";

export const LOGIN_PAGE_URL = `${SITE_ORIGIN}/login`;

export class RiseupLoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RiseupLoginError";
  }
}

export type SendPlatform = "sms" | "whatsapp";

/** The browser the sign-in runs in, open on RiseUp's site. */
export interface LoginBrowser {
  /** A request from RiseUp's page, with its cookies and headers; returns the answer's text. */
  request(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; text: string }>;
  /** Opens a page of RiseUp's site, which may redirect to its sign-in provider. */
  open(path: string): Promise<void>;
  /** Whether RiseUp counts this browser as signed in. */
  signedIn(): Promise<boolean>;
  /** The browser's screen as a PNG. */
  screen(): Promise<Uint8Array>;
  click(x: number, y: number): Promise<void>;
  type(text: string): Promise<void>;
  press(key: string): Promise<void>;
  /** The address the browser is on, for the person to see where they are. */
  location(): string;
  /** RiseUp's cookies, HttpOnly ones included. */
  cookies(): Promise<Cookie[]>;
  close(): Promise<void>;
}

export type OpenBrowser = () => Promise<LoginBrowser>;

/** The keys the sign-in page can send besides typed text. */
export const KEYS = ["Enter", "Tab", "Backspace", "Escape", "ArrowUp", "ArrowDown"] as const;

/** A mobile number as RiseUp's page takes it: 05XXXXXXXX. */
export function normalizePhone(phone: string): string | undefined {
  let digits = phone.replace(/[\s()-]/g, "");
  if (digits.startsWith("+972")) digits = `0${digits.slice(4)}`;
  else if (digits.startsWith("972")) digits = `0${digits.slice(3)}`;
  return /^05\d{8}$/.test(digits) ? digits : undefined;
}

/** Asks RiseUp to send the one-time code. */
export async function sendCode(browser: LoginBrowser, phoneNumber: string, sendPlatform: SendPlatform): Promise<void> {
  const res = await browser.request("POST", "/api/no-auth/login/generate-code", { phoneNumber, force: false, sendPlatform });
  if (res.status < 200 || res.status >= 300) {
    throw new RiseupLoginError(
      res.status === 400 || res.status === 404
        ? "RiseUp did not send a code. Check the mobile number on the account."
        : `RiseUp answered HTTP ${res.status}.`,
    );
  }
}

/**
 * Sends the code. Returns "signed_in" when that is all RiseUp asks, or
 * "second_factor" when the browser now shows the provider's pages.
 */
export async function verifyCode(browser: LoginBrowser, phoneNumber: string, code: string): Promise<"signed_in" | "second_factor"> {
  if (!/^\d{4,8}$/.test(code)) throw new RiseupLoginError("The code is digits only.");
  const res = await browser.request("POST", "/api/no-auth/login/authenticate", { phoneNumber, code });
  if (res.status < 200 || res.status >= 300) throw new RiseupLoginError("RiseUp did not accept the code.");
  if (await browser.signedIn()) return "signed_in";
  // As the web app does after a code: the provider's sign-in, which comes back to RiseUp.
  const twoFactor = await browser.request("GET", "/api/partial-auth/is2faRequired");
  let required = true;
  try {
    required = (JSON.parse(twoFactor.text) as { required?: unknown }).required !== false;
  } catch {
    // Unclear: the web app's own start page will route to whatever is needed.
  }
  if (!required) {
    await browser.request("GET", "/api/partial-auth/complete-2fa-web-login");
    if (await browser.signedIn()) return "signed_in";
  }
  await browser.open("/");
  return "second_factor";
}

/** Run in the page, so given as source: a TypeScript loader may wrap compiled functions in helpers the page doesn't have. */
const REQUEST_SCRIPT = `function (method, path, body) {
  var init = { method: method, credentials: "include", headers: { accept: "application/json, text/plain, */*", "RISEUP-PLATFORM": "WEB" } };
  if (body !== undefined) { init.headers["content-type"] = "application/json"; init.body = body; }
  return fetch(path, init).then(function (res) { return res.text().then(function (text) { return { status: res.status, text: text }; }); });
}`;

/**
 * Chromium on RiseUp's sign-in page. Headless unless RISEUP_HEADLESS=false;
 * RISEUP_CHROMIUM_PATH picks another Chromium than Playwright's own.
 *
 * It runs full Chromium without the automation flag or "HeadlessChrome" in
 * its user agent; Google's sign-in still refuses headless Chromium, so the
 * image runs it with a window on a virtual screen (RISEUP_HEADLESS=false
 * under xvfb-run), with a phone-sized screen so the
 * provider's pages read well on the sign-in page, and keeps one profile in
 * RISEUP_CONFIG_DIR/browser, so a provider that remembers the device asks
 * less next time.
 */
export async function openChromium(): Promise<LoginBrowser> {
  let chromium: typeof import("playwright").chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new RiseupLoginError("Playwright is not installed: run `npm install` and `npx playwright install chromium`.");
  }
  const headless = process.env.RISEUP_HEADLESS !== "false";
  const executablePath = process.env.RISEUP_CHROMIUM_PATH || undefined;
  const profile = join(configDir(), "browser");
  // One sign-in runs at a time, so a lock left in the profile is from a browser that died with its container.
  for (const lock of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) await rm(join(profile, lock), { force: true });
  const context = await chromium
    .launchPersistentContext(profile, {
      headless,
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      // Google refuses to sign in in a browser that says it is automated.
      args: ["--disable-blink-features=AutomationControlled"],
      ignoreDefaultArgs: ["--enable-automation"],
      locale: "he-IL",
      timezoneId: "Asia/Jerusalem",
      viewport: { width: 430, height: 860 },
      deviceScaleFactor: 1,
    })
    .catch((err: unknown) => {
      throw new RiseupLoginError(`Could not start Chromium (${err instanceof Error ? err.message : String(err)}). Run \`npx playwright install chromium\`.`);
    });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const userAgent = String(await page.evaluate("navigator.userAgent"));
    if (userAgent.includes("HeadlessChrome")) {
      const plain = userAgent.replace("HeadlessChrome", "Chrome");
      await context.setExtraHTTPHeaders({ "user-agent": plain });
      await context.addInitScript(`Object.defineProperty(Navigator.prototype, "userAgent", { get: () => ${JSON.stringify(plain)} });`);
    }
    await page.goto(LOGIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    return {
      async request(method, path, body) {
        // From RiseUp's own origin, wherever the page has wandered.
        if (!page.url().startsWith(SITE_ORIGIN)) await page.goto(LOGIN_PAGE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
        const args = [method, path, body === undefined ? undefined : JSON.stringify(body)].map((a) => (a === undefined ? "undefined" : JSON.stringify(a)));
        return (await page.evaluate(`(${REQUEST_SCRIPT})(${args.join(", ")})`)) as { status: number; text: string };
      },
      async open(path) {
        await page.goto(new URL(path, SITE_ORIGIN).href, { waitUntil: "domcontentloaded", timeout: 60_000 });
      },
      async signedIn() {
        const res = await context.request.get(new URL("/api/logged-in/", SITE_ORIGIN).href, { headers: { "RISEUP-PLATFORM": "WEB" }, failOnStatusCode: false });
        return res.status() === 200;
      },
      async screen() {
        return new Uint8Array(await page.screenshot({ type: "png" }));
      },
      async click(x, y) {
        const size = page.viewportSize() ?? { width: 430, height: 860 };
        await page.mouse.click(Math.min(Math.max(x, 0), size.width), Math.min(Math.max(y, 0), size.height));
      },
      async type(text) {
        await page.keyboard.type(text, { delay: 30 });
      },
      async press(key) {
        await page.keyboard.press(key);
      },
      location() {
        try {
          return new URL(page.url()).host;
        } catch {
          return "";
        }
      },
      async cookies() {
        const all = await context.cookies(SITE_ORIGIN);
        return all.map((c) => ({ name: c.name, value: c.value, ...(c.expires > 0 ? { expires: Math.floor(c.expires) } : {}) }));
      },
      async close() {
        await context.close();
      },
    };
  } catch (err) {
    await context.close().catch(() => undefined);
    throw err instanceof RiseupLoginError ? err : new RiseupLoginError(`Could not open RiseUp's sign-in page: ${err instanceof Error ? err.message : String(err)}`);
  }
}
