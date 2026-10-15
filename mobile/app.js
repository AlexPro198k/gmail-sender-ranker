import { CLIENT_ID } from "../config.js";
import { applyRule, emptyFolder } from "../gmail-rules.js";
import { scanInbox, listSubjects } from "../gmail-scan.js?v=3";

const SCOPE = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic";
const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");

let token = null;
let tokenExpires = 0;
let tokenClient = null;
let senders = [];

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

// Retries once with a fresh token if Google rejects the cached one.
async function withToken(operation) {
  try {
    return await operation(await getToken());
  } catch (error) {
    if (error.status !== 401) throw error;
    token = null;
    return operation(await getToken());
  }
}

function showApp(signedIn) {
  $("#signin").hidden = signedIn;
  $("#app").hidden = !signedIn;
  $("#sign-out").hidden = !signedIn;
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
    const { subjects } = await withToken((t) => listSubjects(t, sender.email));
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

function render() {
  const query = $("#filter").value.trim().toLowerCase();
  const list = $("#list");
  list.replaceChildren();
  for (const sender of senders.filter((s) => s.name.toLowerCase().includes(query) || s.email.includes(query))) {
    const item = document.createElement("li");
    const top = document.createElement("div");
    top.className = "top";
    const name = document.createElement("div");
    name.className = "name";
    name.textContent = sender.name;
    const email = document.createElement("span");
    email.className = "email";
    email.textContent = sender.email;
    name.append(email);
    const count = document.createElement("button");
    count.className = "count count-btn";
    count.textContent = `${sender.count.toLocaleString()} \uD83D\uDC41`;
    count.setAttribute("aria-label", `Preview subjects for ${sender.name}`);
    count.addEventListener("click", () => showPreview(sender));
    top.append(name, count);

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
    folderName = prompt(`Folder name for ${sender.email}:`, sender.name.slice(0, 60))?.trim();
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
    const r = await withToken((t) => applyRule(t, action, sender.email, fetch, { folderName }));
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
      scanInbox(t, (done, total) => setStatus(`Scanning ${done.toLocaleString()} of ${total.toLocaleString()}...`))
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

function wireEmpty(id, folder, label) {
  $(id).addEventListener("click", async (event) => {
    if (!confirm(`Permanently delete ALL emails in ${label}? This cannot be undone.`)) return;
    event.target.disabled = true;
    setStatus(`Emptying ${label}...`);
    try {
      const r = await withToken((t) => emptyFolder(t, folder));
      setStatus(`${r.deleted.toLocaleString()} emails permanently deleted from ${label}.`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      event.target.disabled = false;
    }
  });
}

$("#sign-in").addEventListener("click", async () => {
  try {
    await getToken();
    showApp(true);
    setStatus("Tap Scan Inbox to begin.");
  } catch (error) {
    alert(error.message);
  }
});
$("#sign-out").addEventListener("click", () => {
  if (token) google.accounts.oauth2.revoke(token);
  token = null;
  senders = [];
  localStorage.removeItem("signedIn");
  $("#list").replaceChildren();
  showApp(false);
});
$("#scan").addEventListener("click", scan);
$("#filter").addEventListener("input", render);
wireEmpty("#empty-trash", "trash", "Trash");
wireEmpty("#empty-spam", "spam", "Spam");
showApp(false);
