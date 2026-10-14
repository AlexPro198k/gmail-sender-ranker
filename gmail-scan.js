const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const CONCURRENCY = 8;

async function call(token, url, fetchImpl, attempt = 0) {
  const res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
  if ((res.status === 429 || res.status === 403 || res.status >= 500) && attempt < 5) {
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
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
