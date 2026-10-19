/**
 * The RiseUp session is a set of HttpOnly cookies on input.riseup.co.il, with
 * no bearer or refresh token. This jar holds them between calls and restarts:
 * it sends them with every API call and takes any the API sets in return.
 */

export interface Cookie {
  name: string;
  value: string;
  /** Epoch seconds; absent for session cookies, which the jar keeps until the session ends. */
  expires?: number;
}

export class CookieJar {
  #cookies = new Map<string, Cookie>();

  constructor(cookies: Cookie[] = []) {
    for (const cookie of cookies) this.#cookies.set(cookie.name, cookie);
  }

  /** The Cookie header, without the ones that have expired. */
  header(now = Date.now()): string {
    return this.list(now)
      .map((c) => `${c.name}=${c.value}`)
      .join("; ");
  }

  list(now = Date.now()): Cookie[] {
    return [...this.#cookies.values()].filter((c) => c.expires === undefined || c.expires * 1000 > now);
  }

  get size(): number {
    return this.#cookies.size;
  }

  /** Takes the Set-Cookie headers of a response; returns whether anything changed. */
  update(res: Response, now = Date.now()): boolean {
    let changed = false;
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const cookie = parseSetCookie(line, now);
      if (!cookie) continue;
      const old = this.#cookies.get(cookie.name);
      if (cookie.expires !== undefined && cookie.expires * 1000 <= now) {
        if (this.#cookies.delete(cookie.name)) changed = true;
      } else if (!old || old.value !== cookie.value || old.expires !== cookie.expires) {
        this.#cookies.set(cookie.name, cookie);
        changed = true;
      }
    }
    return changed;
  }
}

export function parseSetCookie(line: string, now = Date.now()): Cookie | undefined {
  const [pair, ...attributes] = line.split(";");
  const eq = pair?.indexOf("=") ?? -1;
  if (!pair || eq <= 0) return undefined;
  const cookie: Cookie = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim() };
  for (const attribute of attributes) {
    const [key, ...rest] = attribute.split("=");
    const name = key?.trim().toLowerCase();
    const value = rest.join("=").trim();
    if (name === "max-age" && /^-?\d+$/.test(value)) {
      cookie.expires = Math.floor(now / 1000) + Number(value);
    } else if (name === "expires" && cookie.expires === undefined) {
      const ms = Date.parse(value);
      if (!Number.isNaN(ms)) cookie.expires = Math.floor(ms / 1000);
    }
  }
  return cookie;
}
