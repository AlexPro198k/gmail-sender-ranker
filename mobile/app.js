import { CLIENT_ID } from "../config.js";
import { applyRule, emptyFolder, trashInboxOlderThan } from "../gmail-rules.js?v=6";
import { scanInbox, listSubjects } from "../gmail-scan.js?v=6";
import * as msMail from "../ms-mail.js?v=6";
import { cachedMsToken, finishMsSignIn, msConfigured, msSignOut, startMsSignIn } from "../ms-auth.js?v=6";

const SCOPE = "https://mail.google.com/ https://www.googleapis.com/auth/gmail.settings.basic";
const $ = (selector) => document.querySelector(selector);
const statusEl = $("#status");

let token = null;
let tokenExpires = 0;
let tokenClient = null;
let senders = [];
let provider = localStorage.getItem("provider") === "microsoft" ? "microsoft" : "google";
const googleApi = { scanInbox, listSubjects, applyRule, emptyFolder, trashInboxOlderThan };
const api = () => (provider === "microsoft" ? msMail : googleApi);

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
  if (provider === "microsoft") {
    const cached = cachedMsToken();
    if (!cached) {
      await startMsSignIn();
      throw new Error("Redirecting to Microsoft sign-in...");
    }
    try {
      return await operation(cached);
    } catch (error) {
      if (error.status === 401) {
        msSignOut();
        await startMsSignIn();
      }
      throw error;
    }
  }
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
  note.textContent = "Emails are moved to Trash, where Gmail keeps them for 30 days.";
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
  else if (token) google.accounts.oauth2.revoke(token);
  token = null;
  senders = [];
  localStorage.removeItem("signedIn");
  $("#list").replaceChildren();
  $("#filter").hidden = true;
  showApp(false);
  $("#sign-in-ms").hidden = !msConfigured();
});
$("#scan").addEventListener("click", scan);
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

(async () => {
  showApp(false);
  try {
    const returned = await finishMsSignIn();
    if (returned || (provider === "microsoft" && cachedMsToken())) {
      provider = "microsoft";
      showApp(true);
      setStatus("Signed in with Microsoft. Tap Scan Inbox to begin.");
    }
  } catch (error) {
    setStatus(error.message, true);
  }
})();
