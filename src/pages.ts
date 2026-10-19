import type { KeeperStatus } from "./keeper.js";
import { LENGTH_ENDED } from "./keeper.js";

export const PAGE_HEADERS: Record<string, string> = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' blob:; script-src 'self'; connect-src 'self'; form-action 'self'",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const STYLE = `:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:1rem}
main{max-width:30rem;width:100%}
h1{font-size:1.25rem;margin:0 0 .5rem}
p{margin:.25rem 0 1rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.25rem 1rem;margin:0 0 1rem}
dt{opacity:.7}
dd{margin:0}
form{display:inline-block;margin:0 .5rem .5rem 0}
label{display:block;margin:0 0 1rem;font-weight:600}
label.inline{font-weight:400;margin-top:-.5rem}
input[type=text]{display:block;width:100%;box-sizing:border-box;margin-top:.25rem;padding:.6rem;font:inherit;border:1px solid #8888;border-radius:.4rem}
select{font:inherit;padding:.4rem;margin-left:.5rem;border-radius:.4rem}
button{padding:.6rem 1.1rem;font:inherit;border:0;border-radius:.4rem;background:#0b6e4f;color:#fff;cursor:pointer}
button.secondary{background:#8884;color:inherit}
.note{font-size:.85rem;opacity:.7}
.err{color:#b00020}
.screen{position:relative;display:inline-block;max-width:100%;line-height:0;margin:0 0 1rem}
.screen img,input.screen{display:block;max-width:100%;height:auto;border:1px solid #8884;border-radius:.4rem;cursor:pointer;touch-action:manipulation}
.screen .dot{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#0b6e4fcc;pointer-events:none;transition:opacity .6s}
.keys button{padding:.4rem .7rem;margin:0 .25rem .25rem 0}
label.radio{display:inline-block;font-weight:400;margin-right:1rem}`;

function layout(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;
}

function when(iso?: string): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString("en-GB", { timeZone: "Asia/Jerusalem" });
}

function errorLine(error?: string): string {
  return error ? `<p class="err">${escapeHtml(error)}</p>` : "";
}

/** How long a sign-in lasts, as offered at sign-in: value => [label, ms]. */
export const SESSION_LENGTHS: Record<string, [string, number]> = {
  "1h": ["1 hour", 3_600_000],
  "6h": ["6 hours", 6 * 3_600_000],
  "12h": ["12 hours", 12 * 3_600_000],
  "1d": ["1 day", 24 * 3_600_000],
  "2d": ["2 days", 48 * 3_600_000],
  "1w": ["1 week", 7 * 24 * 3_600_000],
  "30d": ["30 days", 30 * 24 * 3_600_000],
};
export const DEFAULT_SESSION_LENGTH = "1w";

function hidden(csrf: string): string {
  return `<input type="hidden" name="csrf" value="${escapeHtml(csrf)}"/>`;
}

function phoneForm(csrf: string, label: string, secondary: boolean): string {
  const options = Object.entries(SESSION_LENGTHS)
    .map(([value, [text]]) => `<option value="${value}"${value === DEFAULT_SESSION_LENGTH ? " selected" : ""}>${text}</option>`)
    .join("");
  return `<form method="post" action="start">${hidden(csrf)}
<label>Mobile number on the RiseUp account<input type="text" name="phone" inputmode="tel" autocomplete="off" pattern="[0-9+ \\-]{9,16}" required/></label>
<p><label class="radio"><input type="radio" name="via" value="sms" checked/> Code by SMS</label><label class="radio"><input type="radio" name="via" value="whatsapp"/> by WhatsApp</label></p>
<label>Stay signed in for<select name="length">${options}</select></label>
<button type="submit"${secondary ? ' class="secondary"' : ""}>${escapeHtml(label)}</button></form>`;
}

function cancelForm(csrf: string): string {
  return `<form method="post" action="cancel">${hidden(csrf)}<button type="submit" class="secondary">Start over</button></form>`;
}

export function phonePage(status: KeeperStatus, csrf: string, error?: string): string {
  let why = "Nobody is signed in to RiseUp yet.";
  if (status.state === "expired") {
    why =
      status.lastError === LENGTH_ENDED
        ? `The session length you chose ran out at ${when(status.endedAt)}.`
        : `RiseUp ended the session at ${when(status.endedAt)}.`;
  }
  return layout(
    "Sign in to RiseUp",
    `<h1>Sign in to RiseUp</h1>
<p>${escapeHtml(why)} RiseUp sends a one-time code to the account's mobile number. If your account has two-step sign-in, its sign-in page is shown here next and you complete it on this page.</p>
${errorLine(error)}
${phoneForm(csrf, "Send code", false)}
<p class="note">Your phone number, the codes and anything you type for two-step sign-in go only to RiseUp and its sign-in provider, through RiseUp's own site. This server keeps the resulting session on this machine.</p>`,
  );
}

export function codePage(csrf: string, error?: string): string {
  return layout(
    "Enter the RiseUp code",
    `<h1>Enter the code</h1>
<p>RiseUp sent a one-time code to your mobile.</p>
${errorLine(error)}
<form method="post" action="code">${hidden(csrf)}
<label>Code<input type="text" name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,8}" required/></label>
<button type="submit">Sign in</button></form>
${cancelForm(csrf)}`,
  );
}

export function statusPage(status: KeeperStatus, csrf: string): string {
  return layout(
    "RiseUp MCP",
    `<h1>RiseUp MCP</h1>
<p>Signed in to RiseUp. While the MCP server runs it checks in every few minutes, and your assistant can use your account until the session ends.</p>
<dl>
<dt>Signed in</dt><dd>${escapeHtml(when(status.signedInAt))}</dd>
<dt>Ends</dt><dd>${escapeHtml(status.endsAt ? when(status.endsAt) : "when RiseUp ends it")}</dd>
<dt>Last checked</dt><dd>${escapeHtml(when(status.lastCheckedAt))}</dd>
</dl>
${status.lastError ? `<p class="err">Last check error: ${escapeHtml(status.lastError)}</p>` : ""}
<p class="note">To change how long the session lasts, sign in again. The current session stays until the new one succeeds.</p>
${phoneForm(csrf, "Sign in again", true)}
<form method="post" action="sign-out">${hidden(csrf)}<button type="submit" class="secondary">Sign out</button></form>`,
  );
}

/** While RiseUp's site works in the background; reloads itself. */
export function workingPage(csrf: string, what: string): string {
  return layout(
    "Signing in to RiseUp",
    `<meta http-equiv="refresh" content="2"/><h1>${escapeHtml(what)}</h1>
<p>This page reloads by itself.</p>
${cancelForm(csrf)}`,
  );
}

/**
 * The sign-in browser's screen, on RiseUp's site or its sign-in provider's: a
 * click on the picture is a click there, and the text box and keys type into
 * whatever field has focus there. screen.js keeps the picture live and sends
 * clicks without reloading; without scripts, the picture is a form button.
 */
export function browserPage(csrf: string, where: string, keys: readonly string[], error?: string): string {
  return layout(
    "Finish signing in",
    `<h1>Finish signing in</h1>
<p>RiseUp asks for its two-step sign-in. This is its page, live, on <b>${escapeHtml(where || "RiseUp")}</b>: tap a field, type below and send, and tap its buttons, as you would there. This page moves on by itself once RiseUp says you are signed in.</p>
${errorLine(error)}
<form method="post" action="click" id="screen-form" data-csrf="${escapeHtml(csrf)}">${hidden(csrf)}
<div class="screen"><input type="image" name="p" src="screen.png?t=${Date.now()}" alt="RiseUp's sign-in page" class="screen" id="screen"/></div></form>
<form method="post" action="type" id="type-form">${hidden(csrf)}
<label>Type into the selected field<input type="text" name="text" autocomplete="off"/></label>
<button type="submit">Type</button></form>
<form method="post" action="key" class="keys">${hidden(csrf)}${keys.map((k) => `<button type="submit" name="key" value="${escapeHtml(k)}" class="secondary">${escapeHtml(k)}</button>`).join("")}</form>
${cancelForm(csrf)}
<script src="screen.js"></script>`,
  );
}

/**
 * Served as screen.js. Swaps the picture for a fresh one about twice a
 * second, sends each tap at the picture's own scale (the page may show it
 * smaller), types without reloading, and reloads once the server stops
 * showing a browser, which moves on to the next step.
 */
export const SCREEN_SCRIPT = `(function () {
  var form = document.getElementById("screen-form");
  var input = document.getElementById("screen");
  var typeForm = document.getElementById("type-form");
  if (!form || !input || !window.fetch) return;
  var csrf = form.getAttribute("data-csrf");
  var img = new Image();
  img.alt = input.alt;
  img.src = input.src;
  var box = input.parentNode;
  box.replaceChild(img, input);
  var missing = 0, busy = false;
  function refresh() {
    if (busy) return;
    busy = true;
    fetch("screen.png?t=" + Date.now(), { cache: "no-store" }).then(function (res) {
      if (res.status === 404) {
        if (++missing >= 3) location.reload();
        return;
      }
      missing = 0;
      return res.blob().then(function (blob) {
        var next = URL.createObjectURL(blob), old = img.src;
        img.onload = function () { if (old.indexOf("blob:") === 0) URL.revokeObjectURL(old); };
        img.src = next;
      });
    }).catch(function () {}).then(function () { busy = false; });
  }
  function send(path, fields) {
    fields.csrf = csrf;
    return fetch(path, { method: "POST", body: new URLSearchParams(fields), headers: { "x-screen-live": "1" } })
      .then(function (res) { if (res.status === 410) location.reload(); setTimeout(refresh, 300); }, function () {});
  }
  img.addEventListener("click", function (e) {
    var rect = img.getBoundingClientRect();
    var scale = img.naturalWidth ? img.naturalWidth / rect.width : 1;
    var x = Math.round((e.clientX - rect.left) * scale), y = Math.round((e.clientY - rect.top) * scale);
    var dot = document.createElement("span");
    dot.className = "dot";
    dot.style.left = (e.clientX - rect.left) + "px";
    dot.style.top = (e.clientY - rect.top) + "px";
    box.appendChild(dot);
    setTimeout(function () { dot.style.opacity = "0"; }, 300);
    setTimeout(function () { dot.remove(); }, 1000);
    send("click", { "p.x": String(x), "p.y": String(y) });
  });
  if (typeForm) typeForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var field = typeForm.querySelector("input[name=text]");
    var text = field.value;
    field.value = "";
    send("type", { text: text });
  });
  setInterval(refresh, 500);
})();
`;

export function messagePage(title: string, message: string): string {
  return layout(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}
