import { applyRule, emptyFolder } from "./gmail-rules.js";
import { scanInbox } from "./gmail-scan.js";
import { clearToken, getAuthState, getToken, signOut } from "./auth.js";

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
  GET_AUTH_STATE: () => getAuthState(),
  SIGN_IN: async () => {
    await getToken();
    return getAuthState();
  },
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
  APPLY_SENDER_RULE: (message) =>
    withToken((token) =>
      applyRule(token, message.action, message.email, fetch, { folderName: message.folderName })
    ),
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
