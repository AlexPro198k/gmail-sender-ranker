import { normalizeEmail } from "./gmail-rules.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const BATCH = 20;
const MAX_RETRIES = 6;
export const MS_AGE_OPTIONS = Object.freeze({ 12: "1 year", 6: "6 months", 3: "3 months", 1: "1 month" });

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function graph(token, path, { method = "GET", body } = {}, fetchImpl = fetch, attempt = 0) {
  const url = path.startsWith("http") ? path : `${GRAPH}${path}`;
  const res = await fetchImpl(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  if ((res.status === 429 || res.status === 503 || res.status === 504) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers?.get?.("retry-after")) * 1000;
    await wait(retryAfter || Math.min(30_000, 1000 * 2 ** attempt));
    return graph(token, path, { method, body }, fetchImpl, attempt + 1);
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
    `/me/mailFolders/inbox/messages?$filter=${filter}&$select=subject,receivedDateTime&$top=${limit}`, fetchImpl, limit);
  const subjects = items
    .map((m) => ({ subject: m.subject || "(no subject)", date: m.receivedDateTime || "" }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, limit);
  return { subjects, total: subjects.length };
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
