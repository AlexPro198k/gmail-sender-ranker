import { normalizeEmail } from "./gmail-rules.js";
import { htmlToText } from "./mail-content.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const BATCH = 20;
const MAX_RETRIES = 6;
export const MS_AGE_OPTIONS = Object.freeze({ 12: "1 year", 6: "6 months", 3: "3 months", 1: "1 month" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(token, path, { method = "GET", body, headers = {} } = {}, fetchImpl = fetch, attempt = 0) {
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });
  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers?.get?.("retry-after")) * 1000;
    await wait(retryAfter || Math.min(30_000, 1000 * 2 ** attempt));
    return graph(token, path, { method, body, headers }, fetchImpl, attempt + 1);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const error = new Error(data?.error?.message || `Microsoft Graph error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

async function pages(token, path, fetchImpl, limit = Infinity) {
  const items = [];
  let url = path;
  while (url && items.length < limit) {
    const data = await graph(token, url, {}, fetchImpl);
    items.push(...(data.value ?? []));
    url = data["@odata.nextLink"];
  }
  return items;
}

const quote = (value) => String(value).replaceAll("'", "''");

// Runs one request per id through $batch (20 at a time) and retries failures a few times.
async function batchEach(token, ids, makeRequest, fetchImpl) {
  let pending = ids;
  let done = 0;
  for (let round = 0; round < 4 && pending.length; round++) {
    if (round) await wait(1500 * round);
    const failed = [];
    let lastError = "";
    for (let i = 0; i < pending.length; i += BATCH) {
      const chunk = pending.slice(i, i + BATCH);
      const data = await graph(token, "/$batch", {
        method: "POST",
        body: { requests: chunk.map((id, n) => ({ id: String(n), ...makeRequest(id) })) }
      }, fetchImpl);
      for (const response of data.responses ?? []) {
        const id = chunk[Number(response.id)];
        if (response.status < 300) done++;
        else if (response.status === 404) done++;
        else { failed.push(id); lastError = response.body?.error?.message || `status ${response.status}`; }
      }
    }
    if (failed.length === pending.length && round === 3) throw new Error(lastError || "Microsoft Graph rejected the request.");
    pending = failed;
  }
  return done;
}

const moveRequest = (destinationId) => (id) => ({
  method: "POST",
  url: `/me/messages/${id}/move`,
  headers: { "Content-Type": "application/json" },
  body: { destinationId }
});

export function parseGraphSender(from) {
  const email = String(from?.emailAddress?.address || "").trim().toLowerCase();
  const name = String(from?.emailAddress?.name || "").trim() || email;
  return { name, email };
}

export async function scanInbox(token, onProgress = () => {}, fetchImpl = fetch) {
  const bySender = new Map();
  let scanned = 0;
  let url = "/me/mailFolders/inbox/messages?$select=from&$top=1000";
  while (url) {
    const data = await graph(token, url, {}, fetchImpl);
    for (const message of data.value ?? []) {
      scanned++;
      const { name, email } = parseGraphSender(message.from);
      if (!email) continue;
      const entry = bySender.get(email) || { name, email, count: 0 };
      entry.count++;
      bySender.set(email, entry);
    }
    onProgress(scanned, scanned);
    url = data["@odata.nextLink"];
  }
  const senders = [...bySender.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { senders, messagesScanned: scanned };
}

export async function listSubjects(token, rawEmail, limit = 100, fetchImpl = fetch) {
  const email = normalizeEmail(rawEmail);
  const filter = encodeURIComponent(`from/emailAddress/address eq '${quote(email)}'`);
  const items = await pages(token,
    `/me/mailFolders/inbox/messages?$filter=${filter}&$select=id,subject,receivedDateTime&$top=${limit}`, fetchImpl, limit);
  const subjects = items
    .map((m) => ({ id: m.id, subject: m.subject || "(no subject)", date: m.receivedDateTime || "" }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
  return { subjects, total: subjects.length };
}

function formatAddress(recipient) {
  const address = recipient?.emailAddress?.address || "";
  const name = recipient?.emailAddress?.name || "";
  if (name && address) return `${name} <${address}>`;
  return name || address;
}

export async function listSpamMessages(token, limit = 100, fetchImpl = fetch) {
  const items = await pages(token,
    `/me/mailFolders/junkemail/messages?$select=id,subject,from,receivedDateTime&$orderby=receivedDateTime%20desc&$top=${limit}`,
    fetchImpl, limit);
  const messages = items
    .map((message) => ({
      id: message.id,
      from: formatAddress(message.from),
      subject: message.subject || "(no subject)",
      date: message.receivedDateTime || ""
    }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
  return { messages, total: messages.length };
}

export async function getMessageContent(token, rawId, fetchImpl = fetch) {
  const id = String(rawId ?? "").trim();
  if (!id) throw new Error("A message ID is required.");
  const params = new URLSearchParams({
    $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,body"
  });
  const data = await graph(token, `/me/messages/${encodeURIComponent(id)}?${params}`, {
    headers: { Prefer: 'outlook.body-content-type="html"' }
  }, fetchImpl);
  const content = data.body?.content || "";
  const bodyHtml = data.body?.contentType?.toLowerCase() === "html" ? content : "";
  return {
    id: data.id || id,
    from: formatAddress(data.from),
    to: (data.toRecipients ?? []).map(formatAddress).filter(Boolean).join(", "),
    cc: (data.ccRecipients ?? []).map(formatAddress).filter(Boolean).join(", "),
    subject: data.subject || "(no subject)",
    date: data.receivedDateTime || data.sentDateTime || "",
    body: bodyHtml ? htmlToText(bodyHtml) : content,
    bodyHtml
  };
}

async function wellKnownId(token, name, fetchImpl) {
  return (await graph(token, `/me/mailFolders/${name}?$select=id`, {}, fetchImpl)).id;
}

async function ensureFolder(token, name, fetchImpl) {
  const filter = encodeURIComponent(`displayName eq '${quote(name)}'`);
  const found = await graph(token, `/me/mailFolders?$filter=${filter}&$select=id`, {}, fetchImpl);
  if (found.value?.length) return found.value[0].id;
  return (await graph(token, "/me/mailFolders", { method: "POST", body: { displayName: name } }, fetchImpl)).id;
}

async function senderMessageIds(token, email, fetchImpl) {
  const trashId = await wellKnownId(token, "deleteditems", fetchImpl);
  const filter = encodeURIComponent(`from/emailAddress/address eq '${quote(email)}'`);
  const items = await pages(token, `/me/messages?$filter=${filter}&$select=id,parentFolderId&$top=100`, fetchImpl);
  return items.filter((m) => m.parentFolderId !== trashId).map((m) => m.id);
}

async function createRule(token, displayName, rule, fetchImpl) {
  const existing = await graph(token, "/me/mailFolders/inbox/messageRules", {}, fetchImpl);
  if (existing.value?.some((r) => r.displayName === displayName)) return false;
  await graph(token, "/me/mailFolders/inbox/messageRules", {
    method: "POST",
    body: { displayName, sequence: 1, isEnabled: true, ...rule }
  }, fetchImpl);
  return true;
}

export async function applyRule(token, action, rawEmail, fetchImpl = fetch, options = {}) {
  if (!["delete", "block", "trash", "folder"].includes(action)) throw new Error("Unknown action.");
  const email = normalizeEmail(rawEmail);
  const me = await graph(token, "/me?$select=mail,userPrincipalName", {}, fetchImpl);
  if ([me.mail, me.userPrincipalName].some((a) => String(a || "").toLowerCase() === email)) {
    throw new Error("Refusing to create a rule for your own address.");
  }
  const conditions = { fromAddresses: [{ emailAddress: { address: email } }] };
  const ruleName = `Sender Ranker: ${action} ${email}`;

  if (action === "folder") {
    const folderName = String(options.folderName ?? "").trim();
    if (!folderName || folderName.length > 100 || /[\r\n]/.test(folderName)) {
      throw new Error("Enter a folder name (up to 100 characters).");
    }
    const folderId = await ensureFolder(token, folderName, fetchImpl);
    const filterCreated = await createRule(token, ruleName, { conditions, actions: { moveToFolder: folderId, stopProcessingRules: true } }, fetchImpl);
    const ids = await senderMessageIds(token, email, fetchImpl);
    const moved = await batchEach(token, ids, moveRequest(folderId), fetchImpl);
    return { email, action, filterCreated, moved, folderName };
  }

  let filterCreated = false;
  if (action === "delete") {
    filterCreated = await createRule(token, ruleName, { conditions, actions: { delete: true, stopProcessingRules: true } }, fetchImpl);
  } else if (action === "block") {
    const blockedId = await ensureFolder(token, "Blocked", fetchImpl);
    filterCreated = await createRule(token, ruleName, {
      conditions,
      actions: { markAsRead: true, moveToFolder: blockedId, stopProcessingRules: true }
    }, fetchImpl);
  }

  const ids = await senderMessageIds(token, email, fetchImpl);
  const trashed = await batchEach(token, ids, moveRequest("deleteditems"), fetchImpl);
  return { email, action, filterCreated, trashed };
}

// Returns senders with more than one folder rule, grouped by domain.
export async function getDuplicateRules(token, fetchImpl = fetch) {
  const rules = await graph(token, "/me/mailFolders/inbox/messageRules", {}, fetchImpl);
  const byDomain = new Map();
  for (const r of rules.value ?? []) {
    if (!r.actions?.moveToFolder) continue;
    for (const a of r.conditions?.fromAddresses ?? []) {
      const email = String(a.emailAddress?.address || "").toLowerCase();
      if (!email) continue;
      const domain = email.split("@")[1] || email;
      const folder = await graph(token, `/me/mailFolders/${r.actions.moveToFolder}?$select=id,displayName`, {}, fetchImpl).catch(() => null);
      if (!folder) continue;
      if (!byDomain.has(domain)) byDomain.set(domain, []);
      byDomain.get(domain).push({ email, ruleId: r.id, ruleName: r.displayName, folderId: folder.id, folderName: folder.displayName });
    }
  }
  return [...byDomain.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([domain, entries]) => ({ domain, entries }));
}

// Merges duplicate folder rules for a domain into one target folder.
export async function mergeRules(token, domain, entries, targetFolderName, fetchImpl = fetch) {
  const targetFolderId = await ensureFolder(token, targetFolderName, fetchImpl);

  // Delete all existing rules for these entries
  for (const { ruleId } of entries) {
    await graph(token, `/me/mailFolders/inbox/messageRules/${ruleId}`, { method: "DELETE" }, fetchImpl).catch(() => {});
  }

  // Move messages from each sender to target folder and recreate one rule per email
  let moved = 0;
  const conditions = { fromAddresses: entries.map((e) => ({ emailAddress: { address: e.email } })) };
  const ruleName = `Sender Ranker: folder ${domain}`;
  for (const { email } of entries) {
    const ids = await senderMessageIds(token, email, fetchImpl);
    if (ids.length) {
      moved += await batchEach(token, ids, moveRequest(targetFolderId), fetchImpl);
    }
  }

  // Create one combined rule for all emails in this domain
  await createRule(token, ruleName, { conditions, actions: { moveToFolder: targetFolderId, stopProcessingRules: true } }, fetchImpl);

  return { domain, targetFolderName, moved };
}

// Returns the folder name an existing Outlook rule routes this sender to, or null.
// Falls back to fuzzy-matching an existing folder name against the sender domain.
export async function getExistingFolder(token, rawEmail, fetchImpl = fetch) {
  const email = normalizeEmail(rawEmail);
  const domain = email.split("@")[1];
  const domainBase = domain.split(".")[0].toLowerCase(); // e.g. "amazon" from "amazon.com"

  // 1. Check existing rules first
  const rules = await graph(token, "/me/mailFolders/inbox/messageRules", {}, fetchImpl);
  const match = (rules.value ?? []).find((r) => {
    if (!r.actions?.moveToFolder) return false;
    const addresses = r.conditions?.fromAddresses ?? [];
    const domains = r.conditions?.senderContains ?? [];
    return addresses.some((a) => String(a.emailAddress?.address || "").toLowerCase() === email)
      || domains.some((d) => String(d).toLowerCase() === domain || email.endsWith("@" + String(d).toLowerCase()));
  });
  if (match) {
    const folder = await graph(token, `/me/mailFolders/${match.actions.moveToFolder}?$select=displayName`, {}, fetchImpl).catch(() => null);
    if (folder?.displayName) return folder.displayName;
  }

  // 2. Fallback: find a folder whose name matches the sender domain base
  const folders = await graph(token, "/me/mailFolders?$select=displayName&$top=100", {}, fetchImpl);
  const fuzzy = (folders.value ?? []).find((f) =>
    f.displayName.toLowerCase().replace(/[^a-z0-9]/g, "") === domainBase.replace(/[^a-z0-9]/g, "")
  );
  return fuzzy?.displayName ?? null;
}

// Permanently deletes everything in Deleted Items or Junk Email.
export async function emptyFolder(token, folder, fetchImpl = fetch) {
  const folderName = { trash: "deleteditems", spam: "junkemail" }[folder];
  if (!folderName) throw new Error("Unknown folder.");
  let deleted = 0;
  for (;;) {
    const data = await graph(token, `/me/mailFolders/${folderName}/messages?$select=id&$top=100`, {}, fetchImpl);
    const ids = (data.value ?? []).map((m) => m.id);
    if (!ids.length) break;
    deleted += await batchEach(token, ids, (id) => ({ method: "DELETE", url: `/me/messages/${id}` }), fetchImpl);
  }
  return { folder, deleted };
}

export async function trashInboxOlderThan(token, months, fetchImpl = fetch) {
  if (!Object.hasOwn(MS_AGE_OPTIONS, months)) throw new Error("Unknown time range.");
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - months);
  const filter = encodeURIComponent(`receivedDateTime lt ${cutoff.toISOString()}`);
  const items = await pages(token, `/me/mailFolders/inbox/messages?$filter=${filter}&$select=id&$top=100`, fetchImpl);
  const trashed = await batchEach(token, items.map((m) => m.id), moveRequest("deleteditems"), fetchImpl);
  return { months, trashed };
}
