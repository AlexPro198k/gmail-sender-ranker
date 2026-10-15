const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const EMAIL_PATTERN = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/;
const BATCH_SIZE = 1000;

export const BLOCKED_LABEL = "Blocked";
export const ACTIONS = Object.freeze({ DELETE: "delete", BLOCK: "block", TRASH: "trash", FOLDER: "folder" });

export function normalizeEmail(value) {
  const email = String(value ?? "").trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) {
    throw new Error("That sender does not have a single, valid email address.");
  }
  return email;
}

async function api(token, path, { method = "GET", body, params } = {}, fetchImpl = fetch) {
  const url = new URL(`${API}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const response = await fetchImpl(url.toString(), {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { "Content-Type": "application/json" } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const error = new Error(data?.error?.message || `Gmail API request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function findLabelId(token, name, fetchImpl) {
  const { labels = [] } = await api(token, "/labels", {}, fetchImpl);
  return labels.find((label) => label.name.toLowerCase() === name.toLowerCase())?.id;
}

async function ensureBlockedLabel(token, fetchImpl) {
  const existing = await findLabelId(token, BLOCKED_LABEL, fetchImpl);
  if (existing) return existing;

  try {
    const created = await api(token, "/labels", {
      method: "POST",
      body: { name: BLOCKED_LABEL, labelListVisibility: "labelShow", messageListVisibility: "show" }
    }, fetchImpl);
    return created.id;
  } catch (error) {
    if (error.status !== 409) throw error;
    const id = await findLabelId(token, BLOCKED_LABEL, fetchImpl);
    if (!id) throw error;
    return id;
  }
}

async function listMessageIds(token, email, fetchImpl) {
  const ids = [];
  let pageToken;
  do {
    const page = await api(token, "/messages", {
      params: {
        q: `from:"${email}" -in:trash`,
        includeSpamTrash: "true",
        maxResults: "500",
        pageToken
      }
    }, fetchImpl);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

async function trashMessages(token, ids, fetchImpl) {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await api(token, "/messages/batchModify", {
      method: "POST",
      body: {
        ids: ids.slice(i, i + BATCH_SIZE),
        addLabelIds: ["TRASH"],
        removeLabelIds: ["INBOX"]
      }
    }, fetchImpl);
  }
}

async function ensureLabel(token, name, fetchImpl) {
  const existing = await findLabelId(token, name, fetchImpl);
  if (existing) return existing;
  try {
    const created = await api(token, "/labels", {
      method: "POST",
      body: { name, labelListVisibility: "labelShow", messageListVisibility: "show" }
    }, fetchImpl);
    return created.id;
  } catch (error) {
    if (error.status !== 409) throw error;
    const id = await findLabelId(token, name, fetchImpl);
    if (!id) throw error;
    return id;
  }
}

async function moveToLabel(token, ids, labelId, fetchImpl) {
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    await api(token, "/messages/batchModify", {
      method: "POST",
      body: { ids: ids.slice(i, i + BATCH_SIZE), addLabelIds: [labelId], removeLabelIds: ["INBOX"] }
    }, fetchImpl);
  }
}

// Permanent deletion needs the full https://mail.google.com/ scope.
export async function emptyFolder(token, folder, fetchImpl = fetch) {
  const query = { trash: "in:trash", spam: "in:spam" }[folder];
  if (!query) throw new Error("Unknown folder.");
  let deleted = 0;
  for (;;) {
    const page = await api(token, "/messages", {
      params: { q: query, includeSpamTrash: "true", maxResults: "500" }
    }, fetchImpl);
    const ids = (page.messages ?? []).map((message) => message.id);
    if (!ids.length) break;
    await api(token, "/messages/batchDelete", { method: "POST", body: { ids } }, fetchImpl);
    deleted += ids.length;
  }
  return { folder, deleted };
}

export async function applyRule(token, action, rawEmail, fetchImpl = fetch, options = {}) {
  if (!Object.values(ACTIONS).includes(action)) throw new Error("Unknown action.");
  const email = normalizeEmail(rawEmail);

  if (action === ACTIONS.FOLDER) {
    const folderName = String(options.folderName ?? "").trim();
    if (!folderName || folderName.length > 100 || /[\r\n]/.test(folderName)) {
      throw new Error("Enter a folder name (up to 100 characters).");
    }
    const profile = await api(token, "/profile", {}, fetchImpl);
    if (String(profile.emailAddress).toLowerCase() === email) {
      throw new Error("Refusing to create a rule for your own address.");
    }
    const labelId = await ensureLabel(token, folderName, fetchImpl);
    let filterCreated = true;
    try {
      await api(token, "/settings/filters", {
        method: "POST",
        body: { criteria: { from: email }, action: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] } }
      }, fetchImpl);
    } catch (error) {
      if (error.status === 400 && /already exists/i.test(error.message)) filterCreated = false;
      else throw error;
    }
    const ids = await listMessageIds(token, email, fetchImpl);
    await moveToLabel(token, ids, labelId, fetchImpl);
    return { email, action, filterCreated, moved: ids.length, folderName };
  }

  const profile = await api(token, "/profile", {}, fetchImpl);
  if (String(profile.emailAddress).toLowerCase() === email) {
    throw new Error("Refusing to create a rule for your own address.");
  }

  let filterCreated = false;
  if (action !== ACTIONS.TRASH) {
    const filterAction = action === ACTIONS.DELETE
      ? { addLabelIds: ["TRASH"] }
      : { addLabelIds: [await ensureBlockedLabel(token, fetchImpl)], removeLabelIds: ["INBOX", "UNREAD"] };

    filterCreated = true;
    try {
      await api(token, "/settings/filters", {
        method: "POST",
        body: { criteria: { from: email }, action: filterAction }
      }, fetchImpl);
    } catch (error) {
      if (error.status === 400 && /already exists/i.test(error.message)) {
        filterCreated = false;
      } else {
        throw error;
      }
    }
  }

  const ids = await listMessageIds(token, email, fetchImpl);
  await trashMessages(token, ids, fetchImpl);

  return { email, action, filterCreated, trashed: ids.length };
}

export const AGE_OPTIONS = Object.freeze({ 12: "1 year", 6: "6 months", 3: "3 months", 1: "1 month" });

// Moves Inbox messages older than the chosen number of months to Trash (recoverable for 30 days).
export async function trashInboxOlderThan(token, months, fetchImpl = fetch) {
  if (!Object.hasOwn(AGE_OPTIONS, months)) throw new Error("Unknown time range.");
  const ids = [];
  let pageToken;
  do {
    const page = await api(token, "/messages", {
      params: { q: `in:inbox older_than:${months}m`, maxResults: "500", pageToken }
    }, fetchImpl);
    ids.push(...(page.messages ?? []).map((message) => message.id));
    pageToken = page.nextPageToken;
  } while (pageToken);
  await trashMessages(token, ids, fetchImpl);
  return { months, trashed: ids.length };
}
