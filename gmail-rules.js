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

async function listMessageIds(token, query, fetchImpl) {
  const ids = [];
  let pageToken;
  do {
    const page = await api(token, "/messages", {
      params: {
        q: `${query} -in:trash`,
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

// Returns senders that have more than one folder filter, grouped by domain.
// Each entry: { domain, emails: [{email, filterId, folderName, labelId}] }
export async function getDuplicateRules(token, fetchImpl = fetch) {
  const { filters = [] } = await api(token, "/settings/filters", {}, fetchImpl);
  const { labels = [] } = await api(token, "/labels", {}, fetchImpl);
  const labelById = Object.fromEntries(labels.map((l) => [l.id, l.name]));
  const systemIds = new Set(["TRASH", "INBOX", "UNREAD", "STARRED", "SPAM"]);

  // Collect folder filters keyed by domain
  const byDomain = new Map();
  for (const f of filters) {
    const from = String(f.criteria?.from || "").toLowerCase().trim();
    if (!from) continue;
    const labelId = f.action?.addLabelIds?.find((id) => !systemIds.has(id));
    if (!labelId) continue;
    const folderName = labelById[labelId];
    if (!folderName) continue;
    const domain = from.includes("@") ? from.split("@")[1] : from;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push({ email: from, filterId: f.id, folderName, labelId });
  }

  return [...byDomain.entries()]
    .filter(([, entries]) => entries.length > 1)
    .map(([domain, entries]) => ({ domain, entries }));
}

// Merges duplicate folder rules for a domain into one target folder.
// Deletes all existing folder filters for those emails, moves messages, recreates one filter.
export async function mergeRules(token, domain, entries, targetFolderName, fetchImpl = fetch) {
  const targetLabelId = await ensureLabel(token, targetFolderName, fetchImpl);

  // Delete all existing filters for these entries
  for (const { filterId } of entries) {
    await api(token, `/settings/filters/${filterId}`, { method: "DELETE" }, fetchImpl).catch(() => {});
  }

  // Move all messages from old labels to target label, then recreate one filter per email
  let moved = 0;
  for (const { email, labelId: oldLabelId } of entries) {
    const ids = await listMessageIds(token, `from:"${email}"`, fetchImpl);
    if (ids.length) {
      await moveToLabel(token, ids, targetLabelId, fetchImpl);
      moved += ids.length;
    }
    // Recreate filter pointing to target
    try {
      await api(token, "/settings/filters", {
        method: "POST",
        body: { criteria: { from: email }, action: { addLabelIds: [targetLabelId], removeLabelIds: ["INBOX"] } }
      }, fetchImpl);
    } catch (error) {
      if (!(error.status === 400 && /already exists/i.test(error.message))) throw error;
    }
  }

  return { domain, targetFolderName, moved };
}

// Returns senders that have more than one folder filter, grouped by domain.
// Falls back to fuzzy-matching an existing label name against the sender domain.
export async function getExistingFolder(token, rawEmail, fetchImpl = fetch) {
  const emails = (Array.isArray(rawEmail) ? rawEmail : [rawEmail]).map(normalizeEmail);
  const domains = [...new Set(emails.map((email) => email.split("@")[1]))];
  const domainRoots = domains.map((domain) => {
    const labels = domain.split(".");
    const multiLabelSuffix = labels.length > 2 &&
      (["com", "co", "net", "org", "gov", "edu", "ac"].includes(labels.at(-2)) ||
        (labels.at(-1) === "gov" && /^[a-z]{2}$/.test(labels.at(-2))));
    return labels.slice(-(multiLabelSuffix ? 3 : 2)).join(".");
  });
  const domainBases = domainRoots.map((root) =>
    root.split(".")[0].replace(/[-_](mail|email|emails|messaging|notify|alerts?)$/, "")
  );

  // 1. Check existing filters first
  const { filters = [] } = await api(token, "/settings/filters", {}, fetchImpl);
  const match = filters.find((f) => {
    const from = String(f.criteria?.from || "").toLowerCase().trim();
    const query = String(f.criteria?.query || "").toLowerCase();
    return emails.some((email) => {
      const domain = email.split("@")[1];
      return from === email || from === domain || from === `@${domain}` ||
        email.endsWith("@" + from) || from.endsWith("@" + domain) ||
        query.includes(domain) || query.includes(`@${domain}`) ||
        domainRoots.some((root) =>
          from === root || from === `@${root}` || from.endsWith(`.${root}`) ||
          query.includes(`from:(${root})`) || query.includes(`from:${root}`)
        );
    });
  });
  if (match) {
    const labelId = match.action?.addLabelIds?.find((id) => !["TRASH", "INBOX", "UNREAD", "STARRED", "SPAM"].includes(id));
    if (labelId) {
      const { labels = [] } = await api(token, "/labels", {}, fetchImpl);
      const name = labels.find((l) => l.id === labelId)?.name;
      if (name) return name;
    }
  }

  // 2. Fallback: find a label whose name matches one of the sender brands.
  const { labels = [] } = await api(token, "/labels", {}, fetchImpl);
  const bases = new Set(domainBases.map((base) => base.replace(/[^a-z0-9]/g, "")));
  const fuzzy = labels.find((l) => l.id.startsWith("Label_") && bases.has(l.name.toLowerCase().replace(/[^a-z0-9]/g, "")));
  return fuzzy?.name ?? null;
}

function normalizeRuleDomains(rawDomains) {
  if (rawDomains === undefined) return null;
  if (!Array.isArray(rawDomains) || rawDomains.length === 0) {
    throw new Error("At least one sender domain is required.");
  }
  const domains = [...new Set(rawDomains.map((value) => String(value).trim().toLowerCase()))];
  if (domains.some((domain) =>
    domain.length > 253 ||
    !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)
  )) {
    throw new Error("A sender domain is invalid.");
  }
  return domains;
}

function isOwnDomain(profileEmail, domains) {
  const ownDomain = String(profileEmail || "").toLowerCase().split("@")[1] || "";
  return domains.some((domain) =>
    ownDomain === domain || ownDomain.endsWith(`.${domain}`) || domain.endsWith(`.${ownDomain}`)
  );
}

function ruleCriteria(email, domains) {
  if (!domains) return { from: email };
  const terms = domains.map((domain) => `from:(${domain})`);
  return { query: terms.length === 1 ? terms[0] : `{${terms.join(" ")}}` };
}

function ruleMessageQuery(email, domains) {
  if (!domains) return `from:"${email}"`;
  const terms = domains.map((domain) => `from:(${domain})`);
  return terms.length === 1 ? terms[0] : `{${terms.join(" ")}}`;
}

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
  const domains = normalizeRuleDomains(options.fromDomains);
  const criteria = ruleCriteria(email, domains);
  const messageQuery = ruleMessageQuery(email, domains);

  if (action === ACTIONS.FOLDER) {
    const folderName = String(options.folderName ?? "").trim();
    if (!folderName || folderName.length > 100 || /[\r\n]/.test(folderName)) {
      throw new Error("Enter a folder name (up to 100 characters).");
    }
    const profile = await api(token, "/profile", {}, fetchImpl);
    if (String(profile.emailAddress).toLowerCase() === email ||
      (domains && isOwnDomain(profile.emailAddress, domains))) {
      throw new Error("Refusing to create a rule for your own address.");
    }
    const labelId = await ensureLabel(token, folderName, fetchImpl);
    let filterCreated = true;
    try {
      await api(token, "/settings/filters", {
        method: "POST",
        body: { criteria, action: { addLabelIds: [labelId], removeLabelIds: ["INBOX"] } }
      }, fetchImpl);
    } catch (error) {
      if (error.status === 400 && /already exists/i.test(error.message)) filterCreated = false;
      else throw error;
    }
    const ids = await listMessageIds(token, messageQuery, fetchImpl);
    await moveToLabel(token, ids, labelId, fetchImpl);
    return { email, action, filterCreated, moved: ids.length, folderName, ...(domains ? { domains } : {}) };
  }

  const profile = await api(token, "/profile", {}, fetchImpl);
  if (String(profile.emailAddress).toLowerCase() === email ||
    (domains && isOwnDomain(profile.emailAddress, domains))) {
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
        body: { criteria, action: filterAction }
      }, fetchImpl);
    } catch (error) {
      if (error.status === 400 && /already exists/i.test(error.message)) {
        filterCreated = false;
      } else {
        throw error;
      }
    }
  }

  const ids = await listMessageIds(token, messageQuery, fetchImpl);
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
