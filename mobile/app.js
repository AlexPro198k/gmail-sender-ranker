import { CLIENT_ID } from "../config.js";
import { applyRule, emptyFolder, trashInboxOlderThan, getExistingFolder, getDuplicateRules, mergeRules } from "../gmail-rules.js";
import { buildAutoRuleSuggestions } from "./auto-rules.js";
import { scanInbox, listSubjects, listSpamMessages, getMessageContent } from "../gmail-scan.js";
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
  const apply = (theme) => {
    if (theme === "holonet") {
      root.setAttribute("data-theme", "holonet");
      btn.textContent = "Default";
      btn.setAttribute("aria-label", "Switch to default theme");
    } else {
      root.removeAttribute("data-theme");
      btn.textContent = "HOLONET";
      btn.setAttribute("aria-label", "Switch to HOLONET theme");
    }
  };
  apply(localStorage.getItem("theme") || "ios");
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
const googleApi = { scanInbox, listSubjects, listSpamMessages, getMessageContent, applyRule, emptyFolder, trashInboxOlderThan, getExistingFolder, getDuplicateRules, mergeRules };

const YAHOO_NOT_AVAILABLE = "Mail management isn't available for Yahoo Mail — Yahoo doesn't provide a public REST API for third-party apps.";

const yahooApi = {
  scanInbox: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  listSubjects: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  listSpamMessages: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
  getMessageContent: () => Promise.reject(new Error(YAHOO_NOT_AVAILABLE)),
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
    const init = () => {
      if (!window.google?.accounts?.oauth2) return reject(new Error("Google sign-in failed to load. Please refresh the page."));
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
    };
    // GSI script loads async — wait up to 10s for it
    if (window.google?.accounts?.oauth2) { init(); return; }
    let waited = 0;
    const poll = setInterval(() => {
      waited += 100;
      if (window.google?.accounts?.oauth2) { clearInterval(poll); init(); }
      else if (waited >= 10_000) { clearInterval(poll); reject(new Error("Google sign-in timed out loading. Please refresh.")); }
    }, 100);
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
  $("#header-signin").hidden = signedIn;
  const h1 = document.querySelector("header h1");
  h1.textContent = signedIn && userLabel ? `Email Organizer \u00b7 ${userLabel}` : "Email Organizer";
  const isYahoo = provider === "yahoo";
  ["#scan", "#empty-trash", "#empty-spam", "#view-spam", "#delete-inbox"].forEach((id) => {
    const el = $(id);
    if (el) el.disabled = isYahoo;
  });
  if (isYahoo && signedIn) setStatus(YAHOO_NOT_AVAILABLE, true);
}

const EMAIL_HTML_TAGS = new Set([
  "a", "b", "blockquote", "br", "caption", "code", "del", "div", "em", "h1", "h2", "h3", "h4", "h5", "h6",
  "hr", "i", "li", "ol", "p", "pre", "s", "span", "strong", "sub", "sup", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "u", "ul"
]);
const EMAIL_HTML_BLOCKED_TAGS = new Set([
  "audio", "base", "button", "embed", "form", "head", "iframe", "input", "link", "math", "meta", "noscript",
  "object", "script", "select", "style", "svg", "textarea", "video"
]);
const EMAIL_IMAGE_PROTOCOLS = new Set(["https:"]);
const EMAIL_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

function safeEmailUrl(value, protocols) {
  const source = String(value || "").trim();
  if (!/^(?:https?:\/\/|mailto:|tel:|\/\/)/i.test(source)) return "";
  try {
    const url = new URL(source, location.href);
    return protocols.has(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}

function copyEmailNodes(source, target, remoteImages) {
  for (const child of source.childNodes) {
    if (child.nodeType === 3) {
      target.append(document.createTextNode(child.textContent));
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.localName.toLowerCase();
    if (EMAIL_HTML_BLOCKED_TAGS.has(tag)) continue;

    if (tag === "img") {
      const image = document.createElement("img");
      image.alt = child.getAttribute("alt") || "";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      const sourceUrl = child.getAttribute("src") || "";
      const dataImage = /^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(sourceUrl) && sourceUrl.length <= 1_000_000;
      const remoteUrl = safeEmailUrl(sourceUrl, EMAIL_IMAGE_PROTOCOLS);
      if (dataImage) image.src = sourceUrl;
      else if (remoteUrl) {
        image.dataset.remoteSrc = remoteUrl;
        remoteImages.push(image);
      }
      for (const attribute of ["width", "height"]) {
        const value = Number.parseInt(child.getAttribute(attribute), 10);
        if (Number.isInteger(value) && value > 0 && value <= 2048) image.setAttribute(attribute, String(value));
      }
      target.append(image);
      continue;
    }

    if (!EMAIL_HTML_TAGS.has(tag)) {
      copyEmailNodes(child, target, remoteImages);
      continue;
    }
    const element = document.createElement(tag);
    if (tag === "a") {
      const href = safeEmailUrl(child.getAttribute("href"), EMAIL_LINK_PROTOCOLS);
      if (href) {
        element.href = href;
        element.target = "_blank";
        element.rel = "noopener noreferrer";
        element.referrerPolicy = "no-referrer";
      }
    }
    if (tag === "td" || tag === "th") {
      for (const attribute of ["colspan", "rowspan"]) {
        const value = Number.parseInt(child.getAttribute(attribute), 10);
        if (Number.isInteger(value) && value > 0 && value <= 100) element.setAttribute(attribute, String(value));
      }
    }
    copyEmailNodes(child, element, remoteImages);
    target.append(element);
  }
}

function renderEmailHtml(html) {
  const template = document.createElement("template");
  // Keep email markup inert, then rebuild only allowlisted elements for display.
  template.innerHTML = String(html);
  const content = document.createElement("div");
  content.className = "preview-message-html";
  const remoteImages = [];
  copyEmailNodes(template.content, content, remoteImages);
  return { content, remoteImages };
}

async function showMessageViewer({ heading, loadItems, emptyMessage, moreText, showSender = false }) {
  const backdrop = document.createElement("div");
  backdrop.className = "preview-backdrop";
  const modal = document.createElement("div");
  modal.className = "preview-modal";
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  const head = document.createElement("header");
  const title = document.createElement("span");
  title.textContent = heading;
  const close = document.createElement("button");
  close.type = "button";
  close.textContent = "\u2715";
  close.setAttribute("aria-label", "Close preview");
  head.append(title, close);
  const body = document.createElement("div");
  body.textContent = "Loading messages...";
  modal.append(head, body);
  backdrop.append(modal);
  document.body.append(backdrop);

  const dismiss = () => { backdrop.remove(); document.removeEventListener("keydown", onKey); };
  const onKey = (event) => { if (event.key === "Escape") dismiss(); };
  document.addEventListener("keydown", onKey);
  close.addEventListener("click", dismiss);
  backdrop.addEventListener("click", (event) => { if (event.target === backdrop) dismiss(); });

  function renderList(items, total, focusId) {
    title.textContent = heading;
    body.replaceChildren();
    if (!items.length) {
      body.textContent = emptyMessage;
      return;
    }
    const list = document.createElement("ol");
    list.className = "preview-message-list";
    for (const item of items) {
      const li = document.createElement("li");
      const select = document.createElement("button");
      select.type = "button";
      select.className = "preview-message-select";
      select.textContent = item.subject;
      select.disabled = !item.id;
      select.setAttribute("aria-label", `Read message: ${item.subject}`);
      select.addEventListener("click", () => openMessage(item, items, total));
      li.append(select);
      const metadata = [showSender && item.from, item.date].filter(Boolean).join(" · ");
      if (metadata) {
        const small = document.createElement("small");
        small.textContent = metadata;
        li.append(small);
      }
      list.append(li);
      if (item.id === focusId) select.dataset.focusTarget = "true";
    }
    body.append(list);
    const moreMessage = moreText?.(items, total);
    if (moreMessage) {
      const note = document.createElement("small");
      note.textContent = moreMessage;
      body.append(note);
    }
    body.querySelector("[data-focus-target]")?.focus();
  }

  function renderMessage(message, items, total, selected, error) {
    title.textContent = error ? selected.subject : message.subject;
    body.replaceChildren();
    const back = document.createElement("button");
    back.type = "button";
    back.className = "preview-message-back";
    back.textContent = "Back to messages";
    back.addEventListener("click", () => renderList(items, total, selected.id));
    body.append(back);
    if (error) {
      const errorMessage = document.createElement("p");
      errorMessage.className = "preview-message-error";
      errorMessage.textContent = error;
      body.append(errorMessage);
      return;
    }

    const detail = document.createElement("article");
    detail.className = "preview-message-detail";
    const metadata = document.createElement("dl");
    for (const [label, value] of [["From", message.from], ["To", message.to], ["Cc", message.cc], ["Date", message.date]]) {
      if (!value) continue;
      const row = document.createElement("div");
      row.className = "preview-message-meta-row";
      const name = document.createElement("dt");
      name.textContent = label;
      const content = document.createElement("dd");
      content.textContent = value;
      row.append(name, content);
      metadata.append(row);
    }
    detail.append(metadata);
    if (message.bodyHtml) {
      const { content, remoteImages } = renderEmailHtml(message.bodyHtml);
      if (!content.hasChildNodes()) content.textContent = message.body || "No readable message body.";
      if (remoteImages.length) {
        const imageNotice = document.createElement("div");
        imageNotice.className = "preview-message-image-notice";
        const notice = document.createElement("span");
        notice.textContent = `${remoteImages.length} remote image${remoteImages.length === 1 ? "" : "s"} blocked for privacy.`;
        const loadImages = document.createElement("button");
        loadImages.type = "button";
        loadImages.className = "preview-message-load-images";
        loadImages.textContent = "Load images";
        loadImages.addEventListener("click", () => {
          for (const image of remoteImages) {
            image.src = image.dataset.remoteSrc;
            delete image.dataset.remoteSrc;
          }
          imageNotice.remove();
        });
        imageNotice.append(notice, loadImages);
        detail.append(imageNotice);
      }
      detail.append(content);
    } else {
      const content = document.createElement("pre");
      content.className = "preview-message-body";
      content.textContent = message.body || "No readable message body.";
      detail.append(content);
    }
    body.append(detail);
  }

  async function openMessage(item, items, total) {
    body.textContent = "Loading message...";
    try {
      const message = await withToken((t) => api().getMessageContent(t, item.id));
      if (backdrop.isConnected) renderMessage(message, items, total, item);
    } catch (error) {
      if (backdrop.isConnected) renderMessage(null, items, total, item, error.message);
    }
  }

  try {
    const { items, total } = await loadItems();
    renderList(items, total);
  } catch (error) {
    body.textContent = error.message;
  }
}

function showPreview(sender) {
  return showMessageViewer({
    heading: `${sender.name} <${sender.email}>`,
    loadItems: async () => {
      const { subjects } = await withToken((t) => api().listSubjects(t, sender.email));
      return { items: subjects, total: sender.count };
    },
    emptyMessage: "No Inbox emails found for this sender.",
    moreText: (items, total) => total > items.length ? `Showing the latest ${items.length} of ${total}.` : ""
  });
}

function showSpam() {
  return showMessageViewer({
    heading: "Spam",
    loadItems: async () => {
      const { messages, total } = await withToken((t) => api().listSpamMessages(t));
      return { items: messages, total };
    },
    emptyMessage: "No Spam emails found.",
    moreText: (items, total) => total > items.length ? `Showing the latest ${items.length} of ${total}.` : "",
    showSender: true
  });
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
    result.setAttribute("role", "status");
    result.setAttribute("aria-live", "polite");
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

function setResult(result, state, message) {
  result.className = state ? `result ${state}` : "result";
  result.textContent = message;
}

async function run(action, sender, buttons, result, item) {
  let folderName;
  if (action === "folder") {
    let suggested;
    try {
      suggested = await withToken((t) => api().getExistingFolder(t, sender.email));
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
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
  setResult(result, "pending", "Working...");
  try {
    const r = await withToken((t) => api().applyRule(t, action, sender.email, fetch, { folderName }));
    const moved = r.moved ?? r.trashed;
    setResult(result, "success", `${moved.toLocaleString()} emails moved` +
      (action === "trash" ? "." : r.filterCreated ? "; rule created." : "; rule already existed."));
    senders = senders.filter((s) => s !== sender);
    setTimeout(() => item.remove(), 1500);
  } catch (error) {
    setResult(result, "error", error.message);
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
          note.classList.remove("rule-success", "rule-error");
          note.textContent = "Working...";
          try {
            const r = await withToken((t) => api().mergeRules(t, domain, entries, folderName));
            note.textContent = `Done. ${r.moved.toLocaleString()} emails moved to "${folderName}".`;
            note.classList.add("rule-success");
          } catch (error) {
            note.textContent = error.message;
            note.classList.add("rule-error");
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

  let suggestions;
  try {
    suggestions = buildAutoRuleSuggestions(senders);
    for (const suggestion of suggestions) {
      if (suggestion.action !== "folder") continue;
      const existing = await withToken((t) =>
        api().getExistingFolder(t, provider === "google"
          ? suggestion.group.map((sender) => sender.email)
          : suggestion.group[0].email)
      );
      if (existing) suggestion.folderName = existing;
    }
  } catch (error) {
    spinnerWrap.remove();
    btn.disabled = false;
    const message = document.createElement("p");
    message.className = "result error";
    message.setAttribute("role", "status");
    message.setAttribute("aria-live", "polite");
    message.textContent = `Could not prepare auto-rule suggestions: ${error.message}`;
    body.append(message);
    return;
  }
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

  for (const { group, action, folderName, totalCount, matchDomains } of suggestions) {
    const item = document.createElement("div");
    item.className = "auto-rule-item";

    const domainLabel = document.createElement("div");
    domainLabel.className = "rules-domain";
    domainLabel.textContent = folderName;

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
    resultEl.setAttribute("role", "status");
    resultEl.setAttribute("aria-live", "polite");

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
      setResult(resultEl, "pending", "Working\u2026");
      try {
        let totalMoved = 0;
        if (matchDomains && provider === "google") {
          const options = action === "folder" ? { folderName } : {};
          options.fromDomains = matchDomains;
          const result = await withToken((t) =>
            api().applyRule(t, action, group[0].email, fetch, options)
          );
          totalMoved = result.moved ?? result.trashed ?? 0;
        } else {
          for (const sender of group) {
            const options = action === "folder" ? { folderName } : {};
            const result = await withToken((t) =>
              api().applyRule(t, action, sender.email, fetch, options)
            );
            totalMoved += result.moved ?? result.trashed ?? 0;
          }
        }
        senders = senders.filter((sender) => !group.includes(sender));
        render();
        setResult(resultEl, "success", `Done \u00b7 ${totalMoved.toLocaleString()} emails moved`);
        finish(true);
      } catch (error) {
        setResult(resultEl, "error", error.message);
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
  // Restore individual provider button visibility inside the header signin group
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
    setStatus(error.message, true);
  }
});

$("#sign-out").addEventListener("click", () => {
  if (provider === "microsoft") msSignOut();
  else if (provider === "yahoo") yahooSignOut();
  else if (token) google.accounts.oauth2.revoke(token);
  localStorage.removeItem("provider");
  resetSignIn();
});

$("#sign-in-ms").addEventListener("click", () => {
  localStorage.setItem("provider", "microsoft");
  startMsSignIn().catch((error) => setStatus(error.message, true));
  // startMsSignIn redirects the page — no await, no throw handling needed
});

$("#sign-in-yahoo").addEventListener("click", () => {
  localStorage.setItem("provider", "yahoo");
  startYahooSignIn().catch((error) => setStatus(error.message, true));
});

$("#scan").addEventListener("click", scan);
$("#manage-rules").addEventListener("click", showManageRules);
$("#auto-rule").addEventListener("click", showAutoRule);
$("#filter").addEventListener("input", render);
wireEmpty("#empty-trash", "trash", "Trash");
wireEmpty("#empty-spam", "spam", "Spam");
$("#view-spam").addEventListener("click", showSpam);
$("#delete-inbox").addEventListener("click", () =>
  showDeleteInbox((months) => withToken((t) => api().trashInboxOlderThan(t, months)), setStatus)
);

(async () => {
  // Set individual provider button visibility before showApp
  $("#sign-in-ms").hidden = !msConfigured();
  $("#sign-in-yahoo").hidden = !yahooConfigured();
  showApp(false);
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
