const scanButton = document.querySelector("#scan");
const status = document.querySelector("#status");
const resultsSection = document.querySelector("#results");
const summary = document.querySelector("#summary");
const senderList = document.querySelector("#sender-list");
const filterInput = document.querySelector("#filter");
const downloadButton = document.querySelector("#download");

let senders = [];

// The maximized overlay is a separate page, so scan results are shared through storage.
function saveResults() {
  chrome.storage.local.set({ lastScan: { senders, summary: summary.textContent, savedAt: Date.now() } });
}

async function restoreResults() {
  const { lastScan } = await chrome.storage.local.get("lastScan");
  if (!lastScan?.senders?.length || senders.length) return;
  senders = lastScan.senders;
  summary.textContent = lastScan.summary;
  resultsSection.hidden = false;
  renderSenders();
  setStatus(`Showing results from ${new Date(lastScan.savedAt).toLocaleString()}. Scan again to refresh.`);
}

function setStatus(message, isError = false) {
  status.textContent = message;
  status.classList.toggle("error", isError);
}

async function runRule(action, sender, buttons, result) {
  let folderName;
  if (action === "folder") {
    folderName = prompt(`Name the folder (label) for emails from ${sender.email}:`, sender.name.slice(0, 60))?.trim();
    if (!folderName) return;
  }
  const description = action === "folder"
    ? `move ALL emails from this sender into the folder "${folderName}" and create a filter that files their future emails there`
    : action === "trash"
    ? "move ALL emails from this sender to Trash (no rule is created, future emails are unaffected)"
    : action === "delete"
    ?  "move ALL existing emails from this sender to Trash and create a filter that always deletes their future emails"
    : "move ALL existing emails from this sender to Trash and create a filter that skips the Inbox, marks future emails as read and labels them \"Blocked\"";
  if (!confirm(`${sender.name} <${sender.email}>\n\nThis will ${description}.\n\nContinue?`)) return;

  buttons.forEach((button) => (button.disabled = true));
  result.className = "row-result";
  result.textContent = "Working...";
  try {
    const response = await chrome.runtime.sendMessage({     type: "APPLY_SENDER_RULE", action, email: sender.email, folderName });
    if (!response?.ok) throw new Error(response?.error || "No response from the extension.");
        const { trashed, filterCreated, moved } = response.result;
        result.textContent = action === "folder"
          ? `${moved.toLocaleString()} moved to "${folderName}"; ` + (filterCreated ? "rule created." : "rule already existed.")
          : action === "trash"
      ? `${trashed.toLocaleString()} moved to Trash.`
      : `${trashed.toLocaleString()} moved to Trash; ` +
        (filterCreated ? "rule created." : "rule already existed.");
  } catch (error) {
    result.classList.add("error");
    result.textContent = error instanceof Error ? error.message : String(error);
    buttons.forEach((button) => (button.disabled = false));
  }
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
  close.focus();

  try {
    const response = await chrome.runtime.sendMessage({ type: "LIST_SUBJECTS", email: sender.email });
    if (!response?.ok) throw new Error(response?.error || "No response from the extension. Sign in first.");
    const { subjects } = response.result;
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
    body.textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderSenders() {
  const query = filterInput.value.trim().toLocaleLowerCase();
  const visible = senders.filter((sender) => sender.name.toLocaleLowerCase().includes(query));
  senderList.replaceChildren();

  for (const [index, sender] of visible.entries()) {
    const row = document.createElement("tr");
    const rankCell = document.createElement("td");
    const nameCell = document.createElement("td");
    const countCell = document.createElement("td");

    const actionCell = document.createElement("td");

    rankCell.textContent = String(index + 1);
    nameCell.textContent = sender.name;
    if (sender.email) {
      const email = document.createElement("span");
      email.className = "email";
      email.textContent = sender.email;
      nameCell.append(email);
    }
    countCell.textContent = String(sender.count);

    const actions = document.createElement("div");
    actions.className = "actions";
    const result = document.createElement("div");
    result.className = "row-result";
    const buttons = [
      ["trash", "Move all emails from this sender to Trash", "Delete"],
      ["folder", "Create a folder, move all emails there and file future emails into it", "Folder"],
      ["delete", "Delete Always", "Delete Always"],
      ["block", "Always Block this Sender", "Block"]
    ].map(([action, title, label]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action;
      button.textContent = label;
      button.title = sender.email ? title : "Unavailable: this row has no single email address.";
      button.disabled = !sender.email;
      button.addEventListener("click", () => runRule(action, sender, buttons, result));
      return button;
    });
    actions.append(...buttons);
    actionCell.append(actions, result);

    row.append(rankCell, nameCell, countCell, actionCell);
    senderList.append(row);
  }

  if (query && visible.length === 0) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 4;
    cell.textContent = "No matching senders.";
    row.append(cell);
    senderList.append(row);
  }
}

scanButton.addEventListener("click", async () => {
  scanButton.disabled = true;
  resultsSection.hidden = true;
  setStatus("Scanning Inbox conversations. Keep Gmail open; the Inbox view will be restored when done.");

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://mail.google.com/")) {
      throw new Error("Open Gmail in the active tab, then start the scan again.");
    }

    const response = await chrome.tabs.sendMessage(tab.id, { type: "SCAN_INBOX_SENDERS" });
    if (!response?.ok) {
      throw new Error(response?.error || "Gmail did not return scan results.");
    }

    senders = response.result.senders;
    summary.textContent =
      `Scanned ${response.result.conversationsScanned.toLocaleString()} conversations ` +
      `across ${response.result.pagesScanned.toLocaleString()} Inbox pages; ` +
      `${senders.length.toLocaleString()} distinct sender labels.`;
    resultsSection.hidden = false;
    filterInput.value = "";
    renderSenders();
    saveResults();
    setStatus("Scan complete.");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(
      message.includes("Receiving end does not exist")
        ? "Refresh Gmail after installing the extension, then try again."
        : message,
      true
    );
  } finally {
    scanButton.disabled = false;
  }
});

filterInput.addEventListener("input", renderSenders);

const setupPanel = document.querySelector("#setup");
const signInButton = document.querySelector("#sign-in");

async function showSetupIfNeeded() {
  const response = await chrome.runtime.sendMessage({ type: "GET_AUTH_STATE" });
  if (!response?.ok) return;
  setupPanel.hidden = response.result.signedIn;
  if (!response.result.configured) {
    signInButton.disabled = true;
    document.querySelector("#signin-hint").textContent =
      "Sign-in isn't available in this build yet: set CLIENT_ID in config.js (see README).";
  }
}

signInButton.addEventListener("click", async () => {
  setStatus("Opening Google sign-in...");
  const response = await chrome.runtime.sendMessage({ type: "SIGN_IN" });
  if (response?.ok) {
    setupPanel.hidden = true;
    setStatus("Signed in. You can now scan via API and use the rules.");
  } else {
    setStatus(response?.error || "Sign-in failed.", true);
  }
});

showSetupIfNeeded();

const scanApiButton = document.querySelector("#scan-api");

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SCAN_PROGRESS") {
    setStatus(`Scanning via API: ${message.done.toLocaleString()} / ${message.total.toLocaleString()} messages...`);
  }
});

scanApiButton.addEventListener("click", async () => {
  scanButton.disabled = scanApiButton.disabled = true;
  resultsSection.hidden = true;
  setStatus("Starting API scan...");
  try {
    const response = await chrome.runtime.sendMessage({ type: "SCAN_INBOX_API" });
    if (!response?.ok) throw new Error(response?.error || "No response from the extension.");
    senders = response.result.senders;
    summary.textContent =
      `Scanned ${response.result.messagesScanned.toLocaleString()} Inbox messages; ` +
      `${senders.length.toLocaleString()} distinct sender addresses.`;
    resultsSection.hidden = false;
    filterInput.value = "";
    renderSenders();
    saveResults();
    setStatus("Scan complete.");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
    showSetupIfNeeded();
  } finally {
    scanButton.disabled = scanApiButton.disabled = false;
  }
});

downloadButton.addEventListener("click", () => {
  // A leading apostrophe stops spreadsheets from running text such as "=1+1" as a formula.
  const escapeCsv = (value) => {
    const text = String(value);
    const safe = /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text) ? `'${text}` : text;
    return `"${safe.replaceAll('"', '""')}"`;
  };
  const rows = [["Rank", "Sender label", "Email", "Conversations"]];
  senders.forEach((sender, index) => rows.push([index + 1, sender.name, sender.email ?? "", sender.count]));
  const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\r\n");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "gmail-sender-ranking.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

const inFrame = new URLSearchParams(location.search).has("frame");
document.body.classList.toggle("in-frame", inFrame);
const maximizeButton = document.querySelector("#maximize");

if (inFrame) {
  maximizeButton.textContent = "\u2715";
  maximizeButton.title = "Close";
  maximizeButton.setAttribute("aria-label", "Close");
  maximizeButton.addEventListener("click", () => parent.postMessage({ type: "MSR_CLOSE" }, "https://mail.google.com"));
} else {
  maximizeButton.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url?.startsWith("https://mail.google.com/")) {
      setStatus("Open Gmail in the active tab to maximize.", true);
      return;
    }
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "OPEN_OVERLAY" });
      window.close();
    } catch {
      setStatus("Reload the Gmail tab once, then try maximize again.", true);
    }
  });
}

const minimizeButton = document.querySelector("#minimize");
minimizeButton.addEventListener("click", () => {
  const minimized = document.body.classList.toggle("minimized");
  minimizeButton.setAttribute("aria-pressed", String(minimized));
  minimizeButton.title = minimized ? "Restore" : "Minimize";
  minimizeButton.textContent = minimized ? "+" : "\u2013";
});

restoreResults();

for (const [id, folder, label] of [["#empty-trash", "trash", "Trash"], ["#empty-spam", "spam", "Spam"]]) {
  const button = document.querySelector(id);
  button.addEventListener("click", async () => {
    if (!confirm(`Permanently delete ALL emails in ${label}? This cannot be undone.`)) return;
    button.disabled = true;
    setStatus(`Emptying ${label}...`);
    try {
      const response = await chrome.runtime.sendMessage({ type: "EMPTY_FOLDER", folder });
      if (!response?.ok) throw new Error(response?.error || "No response from the extension.");
      setStatus(`${response.result.deleted.toLocaleString()} emails permanently deleted from ${label}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error), true);
    } finally {
      button.disabled = false;
    }
  });
}
