import { CookieJar, type Cookie } from "./cookies.js";
import type { SavedSession, SessionStore } from "./store.js";

/**
 * Keeps one RiseUp sign-in usable for as long as the person chose.
 *
 * RiseUp has no refresh token: its web session is a cookie that RiseUp ends
 * after a while without a call. The keeper calls RiseUp's own session check
 * every few minutes, which counts as activity, saves any cookies RiseUp sets so a
 * restart picks them up, and drops the session at the end of the length
 * chosen at sign-in. When RiseUp refuses the cookies, the session is gone and
 * a person has to sign in again.
 */

export type KeeperState = "signed_out" | "signed_in" | "expired";

export interface KeeperStatus {
  state: KeeperState;
  signedInAt?: string;
  endsAt?: string;
  lastCheckedAt?: string;
  endedAt?: string;
  lastError?: string;
}

/** Thrown by the check when RiseUp refused the cookies. */
export class SessionRefused extends Error {
  constructor(message = "RiseUp ended the session.") {
    super(message);
    this.name = "SessionRefused";
  }
}

export interface KeeperOptions {
  store: SessionStore;
  /** Between keep-alive rounds; a few minutes, to look like a person keeping the app open. */
  tickMs?: number;
  now?: () => number;
  log?: (line: string) => void;
}

export const DEFAULT_TICK_MS = 5 * 60_000;
export const LENGTH_ENDED = "The session length chosen at sign-in ran out.";

export class SignInRequired extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignInRequired";
  }
}

export class SessionKeeper {
  readonly #store: SessionStore;
  readonly #tickMs: number;
  readonly #now: () => number;
  readonly #log: (line: string) => void;
  #session: SavedSession | undefined;
  #jar: CookieJar | undefined;
  #status: KeeperStatus = { state: "signed_out" };
  #timer: ReturnType<typeof setInterval> | undefined;
  #busy: Promise<unknown> = Promise.resolve();
  /** The keep-alive call; set by the owner, as it needs this keeper's cookies. */
  check: () => Promise<void> = async () => undefined;
  signInHint = "Sign in to RiseUp again.";

  constructor(options: KeeperOptions) {
    this.#store = options.store;
    this.#tickMs = options.tickMs ?? DEFAULT_TICK_MS;
    this.#now = options.now ?? Date.now;
    this.#log = options.log ?? ((line) => console.error(`[keeper] ${line}`));
  }

  status(): KeeperStatus {
    return { ...this.#status };
  }

  async start(): Promise<void> {
    await this.reload();
    void this.tick();
    this.#timer = setInterval(() => void this.tick(), this.#tickMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /** Takes a fresh sign-in: saves it and starts keeping it. */
  async signedIn(cookies: Cookie[], lengthMs: number, userAgent?: string): Promise<void> {
    await this.#serial(async () => {
      const now = this.#now();
      this.#session = { version: 1, cookies, signedInAt: new Date(now).toISOString(), endsAt: now + lengthMs, ...(userAgent ? { userAgent } : {}) };
      this.#jar = new CookieJar(cookies);
      await this.#store.save(this.#session);
      this.#status = { ...this.#fromSession(this.#session), state: "signed_in", lastCheckedAt: new Date(now).toISOString() };
      this.#log(`signed in (cookies: ${cookies.map((c) => c.name).join(", ")})`);
    });
  }

  /** Re-reads the saved session, e.g. one another process signed in. */
  async reload(): Promise<void> {
    await this.#serial(async () => {
      const saved = await this.#store.load();
      if (!saved) {
        this.#session = undefined;
        this.#jar = undefined;
        this.#status = { state: this.#status.state === "expired" ? "expired" : "signed_out" };
        return;
      }
      if (saved.signedInAt !== this.#session?.signedInAt) this.#jar = new CookieJar(saved.cookies);
      this.#session = saved;
      this.#status = { ...this.#fromSession(saved), state: "signed_in" };
      await this.#endIfOver();
    });
  }

  /** One keep-alive round: drop the session past its length, else call RiseUp. */
  async tick(): Promise<void> {
    await this.#serial(() => this.#endIfOver());
    if (!this.#session) return;
    try {
      await this.check();
      this.#status = { ...this.#status, lastCheckedAt: new Date(this.#now()).toISOString() };
      delete this.#status.lastError;
    } catch (err) {
      if (err instanceof SessionRefused) {
        await this.lost(err.message);
        return;
      }
      // A network error: keep the session and try again on the next round.
      const message = err instanceof Error ? err.message : String(err);
      this.#status = { ...this.#status, lastError: message };
      this.#log(`session check failed, will retry: ${message}`);
    }
  }

  /** The cookies to call RiseUp with. Throws SignInRequired when there are none. */
  async jar(): Promise<CookieJar> {
    if (!this.#session) await this.reload();
    await this.#serial(() => this.#endIfOver());
    if (!this.#session || !this.#jar) throw new SignInRequired(this.signInHint);
    return this.#jar;
  }

  /** The user agent of the browser that signed in, if one did. */
  userAgent(): string | undefined {
    return this.#session?.userAgent;
  }

  /** RiseUp set new cookies: save them so a restart has them. */
  async cookiesChanged(): Promise<void> {
    await this.#serial(async () => {
      if (!this.#session || !this.#jar) return;
      this.#session = { ...this.#session, cookies: this.#jar.list(this.#now()) };
      await this.#store.save(this.#session);
    });
  }

  async signOut(): Promise<void> {
    await this.#serial(async () => {
      this.#session = undefined;
      this.#jar = undefined;
      await this.#store.clear();
      this.#status = { state: "signed_out" };
      this.#log("signed out");
    });
  }

  /** RiseUp refused the cookies: forget the session. */
  async lost(reason: string): Promise<void> {
    await this.#serial(() => this.#drop(reason));
  }

  async #drop(reason: string): Promise<void> {
    if (!this.#session) return;
    const signedInAt = this.#session.signedInAt;
    this.#session = undefined;
    this.#jar = undefined;
    await this.#store.clear();
    this.#status = { state: "expired", signedInAt, endedAt: new Date(this.#now()).toISOString(), lastError: reason };
    this.#log(reason === LENGTH_ENDED ? "the chosen session length ran out; signed out" : `RiseUp ended the session: ${reason}`);
  }

  #fromSession(session: SavedSession): KeeperStatus {
    return {
      state: "signed_in",
      signedInAt: session.signedInAt,
      ...(session.endsAt ? { endsAt: new Date(session.endsAt).toISOString() } : {}),
      ...(this.#status.lastCheckedAt ? { lastCheckedAt: this.#status.lastCheckedAt } : {}),
    };
  }

  async #endIfOver(): Promise<void> {
    const endsAt = this.#session?.endsAt;
    if (endsAt !== undefined && this.#now() >= endsAt) await this.#drop(LENGTH_ENDED);
  }

  /** Saves, reloads and sign-outs never overlap. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#busy.then(fn, fn);
    this.#busy = run.catch(() => undefined);
    return run;
  }
}
