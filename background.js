import { applyRule, emptyFolder, trashInboxOlderThan } from "./gmail-rules.js";
import { scanInbox, listSubjects } from "./gmail-scan.js";
import { clearToken, getAuthState, getToken, signOut } from "./auth.js";
import { YAHOO_CLIENT_ID, MS_CLIENT_ID } from "./config.js";

const YAHOO_SCOPE = "openid email profile";
const YAHOO_AUTH = "https://api.login.yahoo.com/oauth2/request_auth";
const MS_SCOPE = "openid email profile User.Read";
const MS_AUTH = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";

async function msSignInExtension() {
  if (!MS_CLIENT_ID) throw new Error("Set MS_CLIENT_ID in config.js to enable Microsoft sign-in.");
  const redirectUri = chrome.identity.getRedirectURL();
  // Use implicit flow (token) since chrome.identity doesn't support PKCE code exchange
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "token",
    redirect_uri: redirectUri,
    scope: MS_SCOPE,
    response_mode: "fragment",
    nonce: Math.random().toString(36).slice(2)
  });
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `${MS_AUTH}?${params}`, interactive: true },
      (redirect) => {
        if (chrome.runtime.lastError || !redirect) {
          return reject(new Error(chrome.runtime.lastError?.message || "Microsoft sign-in was cancelled."));
        }
        const hash = new URLSearchParams(new URL(redirect).hash.slice(1));
        if (hash.get("error")) return reject(new Error(hash.get("error_description") || hash.get("error")));
        // Decode id_token for display info
        const idToken = hash.get("id_token") || "";
        let name = "", email = "";
        try {
          const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          name = payload.name || payload.given_name || "";
          email = payload.email || payload.preferred_username || "";
        } catch { /* ignore */ }
        resolve({ name, email });
      }
    );
  });
}

async function yahooSignIn() {
  if (!YAHOO_CLIENT_ID) throw new Error("Set YAHOO_CLIENT_ID in config.js to enable Yahoo sign-in.");
  const redirectUri = chrome.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id: YAHOO_CLIENT_ID,
    response_type: "token",
    redirect_uri: redirectUri,
    scope: YAHOO_SCOPE,
    nonce: Math.random().toString(36).slice(2)
  });
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: `${YAHOO_AUTH}?${params}`, interactive: true },
      (redirect) => {
        if (chrome.runtime.lastError || !redirect) {
          return reject(new Error(chrome.runtime.lastError?.message || "Yahoo sign-in was cancelled."));
        }
        const hash = new URLSearchParams(new URL(redirect).hash.slice(1));
        const idToken = hash.get("id_token") || "";
        let name = "", email = "";
        try {
          const payload = JSON.parse(atob(idToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
          name = payload.name || payload.given_name || "";
          email = payload.email || "";
        } catch { /* ignore */ }
        resolve({ name, email });
      }
    );
  });
}

async function withToken(operation) {
  const token = await getToken();
  try {
    return await operation(token);
  } catch (error) {
    if (error.status !== 401) throw error;
    await clearToken();
    return operation(await getToken());
  }
}

const handlers = {
  GET_AUTH_STATE: () => getAuthState().then((s) => ({ ...s, yahooConfigured: Boolean(YAHOO_CLIENT_ID), msConfigured: Boolean(MS_CLIENT_ID) })),
  SIGN_IN: async () => {
    await getToken();
    return getAuthState();
  },
  SIGN_IN_YAHOO: () => yahooSignIn(),
  SIGN_IN_MS: () => msSignInExtension(),
  SIGN_OUT: async () => {
    await signOut();
    return getAuthState();
  },
  SCAN_INBOX_API: () =>
    withToken((token) =>
      scanInbox(token, (done, total) =>
        chrome.runtime.sendMessage({ type: "SCAN_PROGRESS", done, total }).catch(() => {})
      )
    ),
  LIST_SUBJECTS: (message) => withToken((token) => listSubjects(token, message.email)),
  APPLY_SENDER_RULE: (message) =>
    withToken((token) =>
      applyRule(token, message.action, message.email, fetch, { folderName: message.folderName })
    ),
  TRASH_OLDER_THAN: (message) => withToken((token) => trashInboxOlderThan(token, Number(message.months))),
  EMPTY_FOLDER: (message) => withToken((token) => emptyFolder(token, message.folder))
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only the extension's own popup page (toolbar popup or Gmail overlay iframe) may use these.
  // Content scripts report the host page URL, so they never match.
  const handler = Object.hasOwn(handlers, message?.type) ? handlers[message.type] : null;
  const fromPopupPage = sender.id === chrome.runtime.id &&
    typeof sender.url === "string" &&
    new URL(sender.url).origin === new URL(chrome.runtime.getURL("/")).origin &&
    new URL(sender.url).pathname === "/popup.html";
  if (!handler || !fromPopupPage) return false;

  handler(message).then(
    (result) => sendResponse({ ok: true, result }),
    (error) => sendResponse({ ok: false, error: error.message, code: error.code })
  );
  return true;
});
