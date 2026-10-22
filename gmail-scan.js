import { htmlToText } from "./mail-content.js";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CONCURRENCY = 8;
// Gmail also caps each user at 15,000 units per minute and messages.get costs 5 (3,000 reads/min).
// About 16 reads/s (~4,800 units/min) leaves headroom for other Gmail clients using the same quota.
const MIN_INTERVAL_MS = 60;
const MAX_RETRIES = 10;

let nextSlot = 0;
async function throttle() {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

async function call(token, url, fetchImpl, attempt = 0) {
  await throttle();
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < MAX_RETRIES) {
    const retryAfter = Number(res.headers?.get?.("retry-after")) * 1000;
    const backoff = Math.min(60_000, 1000 * 2 ** attempt) + Math.random() * 250;
    await new Promise((r) => setTimeout(r, retryAfter > backoff ? retryAfter : backoff));
    return call(token, url, fetchImpl, attempt + 1);
  }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const error = new Error(data.error?.message || `Gmail API error ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

export function parseFrom(header) {
  const value = String(header || "").trim();
  const match = value.match(/^(.*?)\s*<([^<>]+)>\s*$/);
  const email = (match ? match[2] : value).trim().toLowerCase();
  const name = match ? match[1].replace(/^"|"$/g, "").trim() : "";
  return { name: name || email, email };
}

// Counts individual Inbox messages per sender address using metadata only (no bodies).
export async function scanInbox(token, onProgress = () => {}, fetchImpl = fetch) {
  const ids = [];
  let pageToken;
  do {
    const params = new URLSearchParams({ labelIds: "INBOX", maxResults: "500" });
    if (pageToken) params.set("pageToken", pageToken);
    const data = await call(token, `${API}/messages?${params}`, fetchImpl);
    ids.push(...(data.messages || []).map((m) => m.id));
    pageToken = data.nextPageToken;
  } while (pageToken);

  const bySender = new Map();
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < ids.length) {
      const id = ids[next++];
      const params = new URLSearchParams({ format: "metadata", metadataHeaders: "From" });
      let data;
      try {
        data = await call(token, `${API}/messages/${id}?${params}`, fetchImpl);
      } catch (error) {
        if (error.status === 404) { done++; continue; }
        throw error;
      }
      const header = data.payload?.headers?.find((h) => h.name.toLowerCase() === "from")?.value;
      if (header) {
        const { name, email } = parseFrom(header);
        const entry = bySender.get(email) || { name, email, count: 0 };
        entry.count++;
        bySender.set(email, entry);
      }
      if (++done % 25 === 0) onProgress(done, ids.length);
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  onProgress(ids.length, ids.length);

  const senders = [...bySender.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  return { senders, messagesScanned: ids.length };
}

// Lists subjects of Inbox messages from one sender (metadata only), newest first.
export async function listSubjects(token, email, limit = 100, fetchImpl = fetch) {
  const params = new URLSearchParams({ labelIds: "INBOX", maxResults: String(limit), q: `from:${email}` });
  const list = await call(token, `${API}/messages?${params}`, fetchImpl);
  const ids = (list.messages || []).map((m) => m.id);
  const subjects = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      const p = new URLSearchParams({ format: "metadata" });
      p.append("metadataHeaders", "Subject");
      p.append("metadataHeaders", "Date");
      try {
        const data = await call(token, `${API}/messages/${ids[i]}?${p}`, fetchImpl);
        const get = (n) => data.payload?.headers?.find((h) => h.name.toLowerCase() === n)?.value || "";
        subjects[i] = { id: ids[i], subject: get("subject") || "(no subject)", date: get("date") };
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { subjects: subjects.filter(Boolean), total: list.resultSizeEstimate ?? ids.length };
}

export async function listSpamMessages(token, limit = 100, fetchImpl = fetch) {
  const params = new URLSearchParams({ labelIds: "SPAM", maxResults: String(limit) });
  const list = await call(token, `${API}/messages?${params}`, fetchImpl);
  const ids = (list.messages || []).map((message) => message.id);
  const messages = new Array(ids.length);
  let next = 0;
  async function worker() {
    while (next < ids.length) {
      const i = next++;
      const params = new URLSearchParams({ format: "metadata" });
      for (const name of ["From", "Subject", "Date"]) params.append("metadataHeaders", name);
      try {
        const data = await call(token, `${API}/messages/${ids[i]}?${params}`, fetchImpl);
        const get = (name) => data.payload?.headers?.find((header) => header.name.toLowerCase() === name)?.value || "";
        messages[i] = { id: ids[i], from: get("from"), subject: get("subject") || "(no subject)", date: get("date") };
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  return { messages: messages.filter(Boolean), total: list.resultSizeEstimate ?? ids.length };
}

function decodeBase64Url(value, charset) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  let decoder;
  try {
    decoder = new TextDecoder(charset || "utf-8");
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    decoder = new TextDecoder("utf-8");
  }
  return decoder.decode(bytes);
}

function extractBody(payload) {
  const parts = [];
  function collect(part) {
    if (part.body?.data && !part.filename && !part.body.attachmentId) {
      const contentType = part.headers?.find((header) => header.name.toLowerCase() === "content-type")?.value || "";
      const charset = contentType.match(/charset\s*=\s*"?([^;"\s]+)/i)?.[1];
      parts.push({ mimeType: part.mimeType?.toLowerCase(), data: part.body.data, charset });
    }
    for (const child of part.parts ?? []) collect(child);
  }
  collect(payload);

  const plain = parts.filter((part) => part.mimeType === "text/plain");
  const html = parts.find((part) => part.mimeType === "text/html");
  const bodyHtml = html ? decodeBase64Url(html.data, html.charset) : "";
  const body = plain.length
    ? plain.map((part) => decodeBase64Url(part.data, part.charset)).join("\n").trim()
    : htmlToText(bodyHtml);
  return { body, bodyHtml };
}

export async function getMessageContent(token, rawId, fetchImpl = fetch) {
  const id = String(rawId ?? "").trim();
  if (!id) throw new Error("A message ID is required.");
  const params = new URLSearchParams({ format: "full" });
  const data = await call(token, `${API}/messages/${encodeURIComponent(id)}?${params}`, fetchImpl);
  const headers = data.payload?.headers ?? [];
  const get = (name) => headers.find((header) => header.name.toLowerCase() === name)?.value || "";
  const internalDate = data.internalDate ? new Date(Number(data.internalDate)).toISOString() : "";
  const { body, bodyHtml } = extractBody(data.payload ?? {});
  return {
    id: data.id || id,
    from: get("from"),
    to: get("to"),
    cc: get("cc"),
    subject: get("subject") || "(no subject)",
    date: get("date") || internalDate,
    body,
    bodyHtml
  };
}
