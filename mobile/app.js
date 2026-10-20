import { CLIENT_ID } from "../config.js";
import { applyRule, emptyFolder, trashInboxOlderThan, getExistingFolder, getDuplicateRules, mergeRules } from "../gmail-rules.js";
import { scanInbox, listSubjects } from "../gmail-scan.js";
import * as msMail from "../ms-mail.js";
import { cachedMsToken, finishMsSignIn, msConfigured, msSignOut, startMsSignIn } from "../ms-auth.js";
import { cachedYahooToken, finishYahooSignIn, yahooConfigured, yahooSignOut, startYahooSignIn } from "../yahoo-auth.js";

const SCOPE = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic";
const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");

// ── Theme toggle ──
(function initTheme() {
  const root = document.documentElement;
  const btn = document.getElementById("theme-toggle");
  const saved = localStorage.getItem("theme");
  const apply = (theme) => {
    if (theme === "holonet") {
      root.setAttribute("data-theme", "holonet");
      btn.textContent = "iOS";
      btn.setAttribute("aria-label", "Switch to iOS theme");
    } else {
      root.removeAttribute("data-theme");
      btn.textContent = "HOLONET";
      btn.setAttribute("aria-label", "Switch to HOLONET theme");
    }
  };
  apply(saved || "ios");
  btn.addEventListener("click", () => {
    const next = root.getAttribute("data-theme") === "holonet" ? "ios" : "holonet";
    localStorage.setItem("theme", next);
    apply(next);
  });
})();

let token = null;
let tokenExpires = 0;
let tokenClient = null;
let senders = [];
let provider = localStorage.getItem("provider") || "google";
const googleApi = { scanInbox, listSubjects, applyRule, emptyFolder, trashInboxOlderThan, getExistingFolder, getDuplicateRules, mergeRules };

const YAHOO_NOT_AVAILABLE = "Mail management isn't available for Yahoo Mail — Yahoo doesn't provide a public REST API for third-party apps.";

const yahooApi = {
  scanInbox: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  listSubjects: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  applyRule: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  emptyFolder: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  trashInboxOlderThan: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  getExistingFolder: () => Promise.resolve(null),
  getDuplicateRules: () => Promise.resolve([]),
  mergeRules: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE))
};

const api = () => {
  if (provider === "microsoft") return msMail;
  if (provider === "yahoo") return yahooApi;
  return googleApi;
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.classList.toggle("error", isError);
}

function getToken() {
  if (token && Date.now() < tokenExpires - 60_000) return Promise.resolve(token);
  return new Promise((resolve, reject) => {
    if (!window.google?.accounts?.oauth2) return reject(new Error("Google sign-in is still loading. Try again."));
    tokenClient ??= google.accounts.oauth2.initTokenClient({ client_id: CLIENT_ID, scope: SCOPE, callback: () => {} });
    tokenClient.callback = (response) => {
      if (response.error || !response.access_token) return reject(new Error(response.error_description || response.error || "Sign-in failed."));
      token = response.access_token;
      tokenExpires = Date.now() + Number(response.expires_in || 3600) * 1000;
      localStorage.setItem("signedIn", "1");
      resolve(token);
    };
    tokenClient.error_callback = (error) => reject(new Error(error.message || "Sign-in was cancelled."));
    tokenClient.requestAccessToken({ prompt: localStorage.getItem("signedIn") ? "" : "consent" });
  });
}

async function withToken(operation) {
  if (provider === "microsoft") {
    const cached = cachedMsToken();
    if (!cached) { await startMsSignIn(); throw new Error("Redirecting to Microsoft sign-in..."); }
    try {
      return await operation(cached);
    } catch (error) {
      if (error.status === 401) { msSignOut(); await startMsSignIn(); }
      throw error;
    }
  }
  if (provider === "yahoo") {
    const cached = cachedYahooToken();
    if (!cached) { await startYahooSignIn(); throw new Error("Redirecting to Yahoo sign-in..."); }
    return operation(cached.token);
  }
  try {
    return await operation(await getToken());
  } catch (error) {
    if (error.status !== 401) throw error;
    token = null;
    return operation(await getToken());
  }
}

function showApp(signedIn, userLabel = "") {
  $("#signin").hidden = signedIn;
  $("#app").hidden = !signedIn;
  $("#sign-out").hidden = !signedIn;
  if (signedIn && userLabel) {
    const h1 = document.querySelector("header h1");
    h1.textContent = userLabel ? `Sender Ranker · ${userLabel}` : "Sender Ranker";
  } else {
    document.querySelector("header h1").textContent = "Sender Ranker";
  }
  // Disable mail-management buttons for Yahoo
  const isYahoo = provider === "yahoo";
  ["#scan", "#empty-trash", "#empty-spam", "#delete-inbox"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = isYahoo;
  });
  if (isYahoo && signedIn) setStatus(YAHOO_NOT_AVAILABLE, true);
}

async function showPreview(sender) {
  const backdrop = document.createElement("div");
  backdrop.className = "preview-backdrop";
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const head = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = `${sender.name} <${sender.email}>`;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\u2715";
  close.setAttribute("aria-label", "Close preview");
  head.append(title, close);
  const body = document.createElement("div");
  body.textContent = "Loading subjects...";
  modal.append(head, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") dismiss(); };
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });

  try {
    const { subjects } = await withToken((t) => api().listSubjects(t, sender.email));
    if (!subjects.length) { body.textContent = "No Inbox emails found for this sender."; return; }
    const list = document.createElement("ol");
    for (const item of subjects) {
      const li = document.createElement("li");
      li.textContent = item.subject;
      if (item.date) { const d = document.createElement("small"); d.textContent = item.date; li.append(d); }
      list.append(li);
    }
    body.replaceChildren(list);
    if (sender.count > subjects.length) {
      const more = document.createElement("small");
      more.textContent = `Showing the latest ${subjects.length} of ${sender.count}.`;
      body.append(more);
    }
  } catch (error) {
    body.textContent = error.message;
  }
}

function showDeleteInbox(run, setStatus) {
  const backdrop = document.createElement("div");
  backdrop.className = "preview-backdrop";
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const head = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = "Delete Inbox emails older than...";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\u2715";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);
  const note = document.createElement("p");
  note.className = "age-note";
  note.textContent = "Emails are moved to Trash, where they are kept for 30 days.";
  const options = document.createElement("div");
  options.className = "age-options";
  const dismiss = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") dismiss(); };
  for (const [months, label] of [[12, "1 year"], [6, "6 months"], [3, "3 months"], [1, "1 month"]]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `Older than ${label}`;
    button.addEventListener("click", async () => {
      if (!confirm(`Move ALL Inbox emails older than ${label} to Trash?`)) return;
      options.querySelectorAll("button").forEach((b) => (b.disabled = true));
      note.textContent = "Working...";
      try {
        const { trashed } = await run(months);
        dismiss();
        setStatus(`${trashed.toLocaleString()} Inbox emails older than ${label} moved to Trash.`);
      } catch (error) {
        note.textContent = error instanceof Error ? error.message : String(error);
        options.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
    options.append(button);
  }
  modal.append(head, note, options);
  backdrop.append(modal);
  document.body.append(backdrop);
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });
}

function render() {
  const query = $("#filter").value.trim().toLowerCase();
  const list = $("#list");
  list.replaceChildren();
  for (const sender of senders.filter((s) => s.name.toLowerCase().includes(query) || s.email.includes(query))) {
    const item = document.createElement("li");
    const top = document.createElement("div");
    top.className = "top";
    const senderInfo = document.createElement("div");
    senderInfo.className = "sender-info";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = sender.name;
    const email = document.createElement("span");
    email.className = "email";
    email.textContent = sender.email;
    senderInfo.append(name, email);
    const count = document.createElement("button");
    count.className = "count count-btn";
    count.textContent = `${sender.count.toLocaleString()} • view`;
    count.setAttribute("aria-label", `Preview subjects for ${sender.name}`);
    count.addEventListener("click", () => showPreview(sender));
    top.append(senderInfo, count);

    const result = document.createElement("div");
    result.className = "result";
    const actions = document.createElement("div");
    actions.className = "actions";
    const buttons = [
      ["trash", "Delete"],
      ["folder", "Folder"],
      ["delete", "Delete Always"],
      ["block", "Block"]
    ].map(([action, label]) => {
      const button = document.createElement("button");
      button.textContent = label;
      button.addEventListener("click", () => run(action, sender, buttons, result, item));
      return button;
    });
    actions.append(...buttons);
    item.append(top, actions, result);
    list.append(item);
  }
}

async function run(action, sender, buttons, result, item) {
  let folderName;
  if (action === "folder") {
    const suggested = await withToken((t) => api().getExistingFolder(t, sender.email)).catch(() => null);
    folderName = prompt(`Folder name for ${sender.email}:`, suggested || sender.name.slice(0, 60))?.trim();
    if (!folderName) return;
  }
  const descriptions = {
    trash: "move ALL emails from this sender to Trash",
    folder: `move ALL emails from this sender into "${folderName}" and file future emails there`,
    delete: "move ALL emails from this sender to Trash and always delete their future emails",
    block: "move ALL emails from this sender to Trash and block their future emails from the Inbox"
  };
  if (!confirm(`${sender.name} <${sender.email}>\n\nThis will ${descriptions[action]}. Continue?`)) return;

  buttons.forEach((b) => (b.disabled = true));
  result.className = "result";
  result.textContent = "Working...";
  try {
    const r = await withToken((t) => api().applyRule(t, action, sender.email, fetch, { folderName }));
    const moved = r.moved ?? r.trashed;
    result.textContent = `${moved.toLocaleString()} emails moved` + (action === "trash" ? "." : r.filterCreated ? "; rule created." : "; rule already existed.");
    senders = senders.filter((s) => s !== sender);
    setTimeout(() => item.remove(), 1500);
  } catch (error) {
    result.classList.add("error");
    result.textContent = error.message;
    buttons.forEach((b) => (b.disabled = false));
  }
}

async function scan() {
  const button = $("#scan");
  button.disabled = true;
  setStatus("Scanning...");
  try {
    const { senders: found, messagesScanned } = await withToken((t) =>
      api().scanInbox(t, (done, total) => setStatus(`Scanning ${done.toLocaleString()} of ${total.toLocaleString()}...`))
    );
    senders = found;
    $("#filter").hidden = false;
    setStatus(`${messagesScanned.toLocaleString()} messages from ${senders.length.toLocaleString()} senders.`);
    render();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function showManageRules() {
  const backdrop = document.createElement("div");
  backdrop.className = "preview-backdrop";
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const head = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = "Manage Rules";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\u2715";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);
  const body = document.createElement("div");
  body.textContent = "Loading rules...";
  modal.append(head, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") dismiss(); };
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) dismiss(); });

  try {
    const duplicates = await withToken((t) => api().getDuplicateRules(t));
    if (!duplicates.length) {
      body.textContent = "No duplicate rules found.";
      return;
    }
    body.replaceChildren();
    for (const { domain, entries } of duplicates) {
      const group = document.createElement("div");
      group.className = "rules-group";

      const domainLabel = document.createElement("div");
      domainLabel.className = "rules-domain";
      domainLabel.textContent = domain;
      group.append(domainLabel);

      // List existing folders for this domain
      const folderNames = [...new Set(entries.map((e) => e.folderName))];
      const note = document.createElement("p");
      note.className = "age-note";
      note.textContent = `${entries.length} rules across ${folderNames.length} folders. Select one folder to merge into:`;
      group.append(note);

      const options = document.createElement("div");
      options.className = "age-options";
      for (const folderName of folderNames) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = folderName;
        btn.addEventListener("click", async () => {
          if (!confirm(`Merge all "${domain}" rules into "${folderName}"?\n\nOther folders for this sender will be emptied and their rules deleted.`)) return;
          options.querySelectorAll("button").forEach((b) => (b.disabled = true));
          note.textContent = "Working...";
          try {
            const r = await withToken((t) => api().mergeRules(t, domain, entries, folderName));
            note.textContent = `Done. ${r.moved.toLocaleString()} emails moved to "${folderName}".`;
            note.style.color = "var(--green)";
          } catch (error) {
            note.textContent = error.message;
            note.style.color = "var(--red)";
            options.querySelectorAll("button").forEach((b) => (b.disabled = false));
          }
        });
        options.append(btn);
      }
      group.append(options);
      body.append(group);
    }
  } catch (error) {
    body.textContent = error.message;
  }
}

// Splits a display name or local-part into words: camelCase, dots, underscores, dashes, spaces.
function tokenize(str) {
  return str
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[\s._\-@+]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

const PROMO_TOKENS = new Set(["noreply", "no-reply", "donotreply", "newsletter", "news",
  "promo", "promotions", "deals", "offer", "offers", "marketing", "info", "hello",
  "support", "notifications", "notify", "alert", "alerts", "updates", "mailer",
  "bounce", "reply", "auto", "automated", "system", "service", "billing"]);

// Known email provider domain bases — never suggest rules for these
const EMAIL_PROVIDERS = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live",
  "msn", "icloud", "me", "mac", "aol", "proton", "protonmail", "zoho",
  "fastmail", "tutanota", "gmx", "web", "mail", "yandex", "inbox"
]);

function isPromo(sender) {
  const localPart = sender.email.split("@")[0];
  return tokenize(localPart).concat(tokenize(sender.name)).some((t) => PROMO_TOKENS.has(t));
}

function buildAutoRuleSuggestions(list) {
  const byBase = new Map();
  for (const s of list) {
    const domain = s.email.split("@")[1] || "";
    const base = domain.split(".")[0].toLowerCase();
    // Skip: too short (< 4 chars) or a known email provider
    if (base.length < 4 || EMAIL_PROVIDERS.has(base)) continue;
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(s);
  }
  const suggestions = [];
  for (const [base, group] of byBase) {
    const promoCount = group.filter(isPromo).length;
    // Suggest if: multiple senders from same domain base, OR any single promo sender
    if (group.length < 2 && promoCount === 0) continue;
    const allPromo = promoCount === group.length;
    const action = allPromo ? "block" : "folder";
    const folderName = base.charAt(0).toUpperCase() + base.slice(1);
    const totalCount = group.reduce((n, s) => n + s.count, 0);
    suggestions.push({ base, group, action, folderName, totalCount });
  }
  return suggestions.sort((a, b) => b.totalCount - a.totalCount);
}

async function showAutoRule() {
  if (!senders.length) { setStatus("Scan Inbox first to generate suggestions.", true); return; }

  const btn = $("#auto-rule");
  btn.disabled = true;

  // Show modal immediately with spinner while suggestions are computed
  const backdrop = document.createElement("div");
  backdrop.className = "preview-backdrop";
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const head = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = "Auto Rule Suggestions";
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\u2715";
  close.setAttribute("aria-label", "Close");
  head.append(title, close);
  const body = document.createElement("div");
  body.className = "auto-rule-body";

  // Spinner shown while computing
  const spinnerWrap = document.createElement("div");
  spinnerWrap.className = "auto-rule-spinner-wrap";
  const spinner = document.createElement("div");
  spinner.className = "auto-rule-spinner";
  const spinnerLabel = document.createElement("span");
  spinnerLabel.textContent = "Analysing senders\u2026";
  spinnerWrap.append(spinner, spinnerLabel);
  body.append(spinnerWrap);

  modal.append(head, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => {
    backdrop.remove();
    btn.disabled = false;
    document.removeEventListener("keydown", onKey);
  };
  const onKey = (e) => { if (e.key === "Escape") dismiss(); };
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) dismiss(); });

  // Yield to paint the spinner before running sync computation
  await new Promise((r) => setTimeout(r, 0));

  const suggestions = buildAutoRuleSuggestions(senders);
  spinnerWrap.remove();
  btn.disabled = false;

  if (!suggestions.length) {
    const empty = document.createElement("p");
    empty.className = "age-note";
    empty.textContent = "No automatic rule suggestions found. Try scanning more senders.";
    body.append(empty);
    return;
  }

  let remaining = suggestions.length;
  const counter = document.createElement("p");
  counter.className = "age-note";
  const updateCounter = () => {
    counter.textContent = remaining > 0
      ? `${remaining} suggestion${remaining !== 1 ? "s" : ""} remaining`
      : "\u2713 All suggestions reviewed";
  };
  updateCounter();
  body.append(counter);

  for (const { base, group, action, folderName, totalCount } of suggestions) {
    const item = document.createElement("div");
    item.className = "auto-rule-item";

    const domainLabel = document.createElement("div");
    domainLabel.className = "rules-domain";
    domainLabel.textContent = base;

    const emailList = document.createElement("div");
    emailList.className = "auto-rule-emails";
    emailList.textContent = group.map((s) => `${s.name} <${s.email}>`).join("\n");

    const actionBadge = document.createElement("div");
    actionBadge.className = `auto-rule-action auto-rule-action--${action}`;
    actionBadge.textContent = action === "block"
      ? `\uD83D\uDEAB Block \u00b7 ${totalCount.toLocaleString()} emails`
      : `\uD83D\uDCC2 Folder \u201c${folderName}\u201d \u00b7 ${totalCount.toLocaleString()} emails`;

    const btns = document.createElement("div");
    btns.className = "auto-rule-btns";
    const applyBtn = document.createElement("button");
    applyBtn.type = "button";
    applyBtn.className = "auto-rule-apply";
    applyBtn.textContent = "Apply";
    const rejectBtn = document.createElement("button");
    rejectBtn.type = "button";
    rejectBtn.className = "auto-rule-reject";
    rejectBtn.textContent = "Reject";
    const resultEl = document.createElement("div");
    resultEl.className = "result";

    const finish = (accepted) => {
      applyBtn.disabled = true;
      rejectBtn.disabled = true;
      item.classList.add(accepted ? "auto-rule-done" : "auto-rule-rejected");
      remaining--;
      updateCounter();
    };

    rejectBtn.addEventListener("click", () => finish(false));

    applyBtn.addEventListener("click", async () => {
      applyBtn.disabled = true;
      rejectBtn.disabled = true;
      resultEl.className = "result";
      resultEl.textContent = "Working\u2026";
      try {
        let totalMoved = 0;
        for (const sender of group) {
          const r = await withToken((t) =>
            api().applyRule(t, action, sender.email, fetch, action === "folder" ? { folderName } : {})
          );
          totalMoved += r.moved ?? r.trashed ?? 0;
          senders = senders.filter((s) => s !== sender);
        }
        render();
        resultEl.textContent = `\u2713 Done \u00b7 ${totalMoved.toLocaleString()} emails moved`;
        finish(true);
      } catch (error) {
        resultEl.className = "result error";
        resultEl.textContent = error.message;
        applyBtn.disabled = false;
        rejectBtn.disabled = false;
      }
    });

    btns.append(applyBtn, rejectBtn);
    item.append(domainLabel, emailList, actionBadge, btns, resultEl);
    body.append(item);
  }
}

function wireEmpty(id, folder, label) {
  $(id).addEventListener("click", async (event) => {
    if (!confirm(`Permanently delete ALL emails in ${label}? This cannot be undone.`)) return;
    event.target.disabled = true;
    setStatus(`Emptying ${label}...`);
    try {
      const r = await withToken((t) => api().emptyFolder(t, folder));
      setStatus(`${r.deleted.toLocaleString()} emails permanently deleted from ${label}.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      event.target.disabled = false;
    }
  });
}

function resetSignIn() {
  token = null;
  senders = [];
  localStorage.removeItem("signedIn");
  $("#list").replaceChildren();
  $("#filter").hidden = true;
  showApp(false);
  $("#sign-in-ms").hidden = !msConfigured();
  $("#sign-in-yahoo").hidden = !yahooConfigured();
}

$("#sign-in").addEventListener("click", async () => {
  try {
    provider = "google";
    localStorage.setItem("provider", provider);
    await getToken();
    showApp(true);
    setStatus("Tap Scan Inbox to begin.");
  } catch (error) {
    alert(error.message);
  }
});

$("#sign-out").addEventListener("click", () => {
  if (provider === "microsoft") msSignOut();
  else if (provider === "yahoo") yahooSignOut();
  else if (token) google.accounts.oauth2.revoke(token);
  localStorage.removeItem("provider");
  resetSignIn();
});

$("#scan").addEventListener("click", scan);
$("#manage-rules").addEventListener("click", showManageRules);
$("#auto-rule").addEventListener("click", showAutoRule);
$("#filter").addEventListener("input", render);
wireEmpty("#empty-trash", "trash", "Trash");
wireEmpty("#empty-spam", "spam", "Spam");
$("#delete-inbox").addEventListener("click", () =>
  showDeleteInbox((months) => withToken((t) => api().trashInboxOlderThan(t, months)), setStatus)
);

$("#sign-in-ms").hidden = !msConfigured();
$("#sign-in-ms").addEventListener("click", async () => {
  try {
    localStorage.setItem("provider", "microsoft");
    await startMsSignIn();
  } catch (error) {
    alert(error.message);
  }
});

$("#sign-in-yahoo").hidden = !yahooConfigured();
$("#sign-in-yahoo").addEventListener("click", async () => {
  try {
    localStorage.setItem("provider", "yahoo");
    await startYahooSignIn();
  } catch (error) {
    alert(error.message);
  }
});

(async () => {
  showApp(false);
  $("#sign-in-ms").hidden = !msConfigured();
  $("#sign-in-yahoo").hidden = !yahooConfigured();
  try {
    // Microsoft redirect return
    const msReturned = await finishMsSignIn();
    if (msReturned || (provider === "microsoft" && cachedMsToken())) {
      provider = "microsoft";
      localStorage.setItem("provider", provider);
      showApp(true);
      setStatus("Signed in with Microsoft. Tap Scan Inbox to begin.");
      return;
    }
    // Yahoo redirect return
    const yahooSession = await finishYahooSignIn();
    if (yahooSession || (provider === "yahoo" && cachedYahooToken())) {
      provider = "yahoo";
      localStorage.setItem("provider", provider);
      const session = yahooSession || cachedYahooToken();
      const label = session?.email || "Yahoo";
      showApp(true, label);
      return;
    }
    // Google silent restore
    if (provider === "google" && localStorage.getItem("signedIn")) {
      showApp(true);
      setStatus("Tap Scan Inbox to begin.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
})();
