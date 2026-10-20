# riseup-mcp

**Use your own [RiseUp](https://www.riseup.co.il) (רייזאפ) cashflow from an AI assistant over MCP: read a month's budget and transactions, and move transactions between categories (variable, excluded, your tracking categories), as RiseUp's app does.**

[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> Unofficial. Not affiliated with RiseUp. It uses the same API as RiseUp's web app, which can change without notice. For read-only access, RiseUp publishes an official MCP server, [`@riseup-oss/mcp`](https://github.com/riseup-oss/mcp), which uses a personal access token instead of a sign-in; this one exists because that API cannot change anything.

Everything runs on your machine. You sign in on a page this server serves, the session is saved only on your computer, and this project has no hosted backend and collects nothing. Whatever your AI client requests is passed to that client and handled under its provider's privacy terms.

## Terms of use

- **Own account only.**
- **Changes are the app's own.** Every change this server makes is a request RiseUp's web app makes for the same action. It never touches bank or card connections, payments or the subscription.
- **The session file is secret.** It holds RiseUp's session cookies, is saved with mode `0600` under `~/.config/riseup-mcp/`, and must never be committed or pasted.

## Install

```sh
git clone https://github.com/tadnir/riseup-mcp.git
cd riseup-mcp
npm install
npx playwright install chromium
npm test
```

## Use it from an MCP client

```json
{
  "mcpServers": {
    "riseup": {
      "command": "npx",
      "args": ["tsx", "src/main.ts"],
      "cwd": "/absolute/path/to/riseup-mcp"
    }
  }
}
```

For Claude Desktop, use absolute paths: `"command": "/absolute/path/to/node"` with `"args": ["/absolute/path/to/riseup-mcp/node_modules/.bin/tsx", "/absolute/path/to/riseup-mcp/src/main.ts"]`.

### Signing in

1. Ask your assistant something, for example "what did I spend on eating out this month?".
2. While nobody is signed in, the tools answer with a link to a sign-in page this server serves on `http://localhost:8768/`. `riseup_login` returns the same link.
3. Open it, enter the account's mobile number, pick SMS or WhatsApp and how long to stay signed in (1 hour to 30 days), and enter the code RiseUp sends.
4. If your account has two-step sign-in, RiseUp sends the browser on to its sign-in provider. The page then shows that provider's page live: tap its fields and buttons, type in the box below the picture, and the page moves on by itself once RiseUp says you are signed in.
5. Ask again.

Your phone number, the codes and anything you type for two-step sign-in are only ever typed on that page and sent to RiseUp and its provider. The assistant only ever sees the link.

The sign-in runs in a Chromium browser on RiseUp's own site, so the second step works whatever the provider asks, without this server knowing its pages. The browser keeps its profile in `RISEUP_CONFIG_DIR/browser`, so a provider that remembers devices asks less next time.

RiseUp has no refresh token. While the MCP server runs it checks in with RiseUp every 5 minutes, saves the session's cookies, and signs out at the end of the length you picked. A restart picks the saved session back up if it hasn't ended in between.

### Tools

| Tool | What it does |
| --- | --- |
| `get_budget` | One cashflow month as RiseUp's app reads it: envelopes (fixed, variable, tracking categories, income) with their transactions, and the excluded ones |
| `list_transactions` | One month's transactions, each with the category it is in; filter by merchant or category |
| `list_categories` | Where a transaction can move: variable, excluded, and your tracking categories |
| `move_transaction` | Moves one transaction, or every one from its merchant, to variable, out of the cashflow, or into a tracking category; reports where it landed |
| `set_transaction_comment` | Sets a transaction's note |
| `riseup_login`, `riseup_session_status`, `riseup_logout` | The sign-in link, whether a session is live and until when, and sign-out |

`move_transaction` makes the request RiseUp's app makes for that move, picked the way the app picks it from where the transaction is and where it goes:

| From | To | Request |
| --- | --- | --- |
| anywhere | a tracking category | `POST /api/tracking-categories-predicates` |
| fixed | variable | `POST /api/prediction-update/unlink-transaction-from-sequence` |
| a tracking category | variable | `POST /api/tracking-categories-blacklist-predicates` |
| excluded, or any income | variable | `POST /api/investigator/answers/budget-category` (`variable`) |
| anywhere | excluded | `POST /api/investigator/answers/budget-category` (`excluded`) |
| anything else | variable | `POST /api/enrichment-update/save-enrichment` |

Moving into fixed expenses is not supported: the app asks follow-up questions for it.

### Settings

| Variable | Default | Meaning |
| --- | --- | --- |
| `RISEUP_CONFIG_DIR` | `~/.config/riseup-mcp` | Where the session and the sign-in browser's profile are saved |
| `RISEUP_LOGIN_HOST` | `127.0.0.1` | Address the sign-in page listens on |
| `RISEUP_LOGIN_PORT` | `8768` | Its port; a free one is used if another copy holds it |
| `RISEUP_LOGIN_URL` | `http://localhost:<port>/` | The link handed out, when the page sits behind a reverse proxy. When set, the page starts with the server. |
| `RISEUP_HEADLESS` | `true` | `false` runs the sign-in browser with a window. Google's sign-in refuses headless Chromium, so a two-step sign-in through Google needs `false` (on a server, under `xvfb-run`, as the image does) |
| `RISEUP_CHROMIUM_PATH` | Playwright's Chromium | Another Chromium to sign in with |

## Hosting one long-lived copy

To share one session between several clients, run a single copy on an always-on machine at home and put a stdio-to-HTTP MCP proxy in front of it, such as [TBXark/mcp-proxy](https://github.com/TBXark/mcp-proxy), with a bearer token per client. Keep it on your own network or a private VPN, never on the internet. Put the sign-in page behind your own authentication and set `RISEUP_LOGIN_URL` to its address (and `RISEUP_LOGIN_HOST=0.0.0.0` inside a container). Its links and forms are relative, so it can sit at the root of a host or under a path whose prefix the reverse proxy strips (`RISEUP_LOGIN_URL=https://mcp.example.com/riseup/login/`, with the trailing slash).

Every token holder can read and change the account of whoever signed in on the page; the proxy's tokens and the RiseUp session are unrelated. For a second person, run a second copy with its own `RISEUP_CONFIG_DIR`, tokens and sign-in page.

The `Dockerfile` builds an image of the stdio server with Chromium, published as `ghcr.io/tadnir/riseup-mcp` from master, with the session in `/data` and the page on port 8768. Run it with `docker run -i`, or use it as a base for an image that adds your MCP proxy.

The sign-in page answers only to `localhost`, `127.0.0.1` and the host in `RISEUP_LOGIN_URL`, and each form carries a per-process token. Anyone who can open the page can sign in or out, so keep it on loopback or behind your own authentication.

## License

[MIT](LICENSE)
