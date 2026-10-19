import { describe, expect, test, vi } from "vitest";
import { LENGTH_ENDED, SessionKeeper, SessionRefused, SignInRequired } from "../src/keeper.js";
import { memoryStore } from "./helpers.js";

const HOUR = 3_600_000;
const quiet = () => undefined;
const cookies = [{ name: "session", value: "s1" }];

describe("SessionKeeper", () => {
  test("signed out: calls get the sign-in hint", async () => {
    const keeper = new SessionKeeper({ store: memoryStore(), log: quiet });
    keeper.signInHint = "go sign in";
    await keeper.reload();
    expect(keeper.status().state).toBe("signed_out");
    await expect(keeper.jar()).rejects.toThrow(new SignInRequired("go sign in"));
  });

  test("a sign-in is saved with its end time and its cookies are used", async () => {
    const now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, now: () => now, log: quiet });
    await keeper.signedIn(cookies, 24 * HOUR);
    expect(store.saved).toMatchObject({ cookies, endsAt: now + 24 * HOUR });
    expect((await keeper.jar()).header(now)).toBe("session=s1");
    expect(keeper.status()).toMatchObject({ state: "signed_in", endsAt: new Date(now + 24 * HOUR).toISOString() });
  });

  test("each round checks in with RiseUp", async () => {
    let now = 1_000 * HOUR;
    const keeper = new SessionKeeper({ store: memoryStore(), now: () => now, log: quiet });
    keeper.check = vi.fn(async () => undefined);
    await keeper.signedIn(cookies, 24 * HOUR);
    now += 5 * 60_000;
    await keeper.tick();
    expect(keeper.check).toHaveBeenCalledOnce();
    expect(keeper.status().lastCheckedAt).toBe(new Date(now).toISOString());
  });

  test("a refused check ends the session; a network error doesn't", async () => {
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, log: quiet });
    await keeper.signedIn(cookies, 24 * HOUR);
    keeper.check = async () => {
      throw new Error("ECONNRESET");
    };
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "signed_in", lastError: "ECONNRESET" });
    keeper.check = async () => {
      throw new SessionRefused();
    };
    await keeper.tick();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: "RiseUp ended the session." });
    expect(store.saved).toBeUndefined();
  });

  test("the chosen length ends the session without asking RiseUp", async () => {
    let now = 1_000 * HOUR;
    const store = memoryStore();
    const keeper = new SessionKeeper({ store, now: () => now, log: quiet });
    keeper.check = vi.fn(async () => undefined);
    await keeper.signedIn(cookies, HOUR);
    now += HOUR;
    await keeper.tick();
    expect(keeper.check).not.toHaveBeenCalled();
    expect(keeper.status()).toMatchObject({ state: "expired", lastError: LENGTH_ENDED });
    await expect(keeper.jar()).rejects.toThrow(SignInRequired);
  });

  test("a restart picks the saved session back up", async () => {
    const store = memoryStore();
    const first = new SessionKeeper({ store, log: quiet });
    await first.signedIn(cookies, 24 * HOUR);
    const second = new SessionKeeper({ store, log: quiet });
    await second.reload();
    expect(second.status().state).toBe("signed_in");
    expect((await second.jar()).header()).toBe("session=s1");
  });
});
