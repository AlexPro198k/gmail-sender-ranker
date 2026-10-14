import { CLIENT_ID } from "./config.js";

const SCOPES = [
  "https://mail.google.com/",
  "https://www.googleapis.com/auth/gmail.settings.basic"
];
const CLIENT_ID_PATTERN = /^[\w-]+\.apps\.googleusercontent\.com$/;
const isConfigured = () => CLIENT_ID_PATTERN.test(CLIENT_ID);

export class AuthError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export const getRedirectUri = () => chrome.identity.getRedirectURL();

export async function clearToken() {
  await chrome.storage.session.remove("auth");
}

async function readCachedToken() {
  const { auth } = await chrome.storage.session.get("auth");
  return auth && auth.expires > Date.now() + 60_000 ? auth.token : null;
}

function launch(url, interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive }, (redirect) => {
      if (chrome.runtime.lastError || !redirect) {
        reject(new Error(chrome.runtime.lastError?.message || "Google sign-in was cancelled."));
      } else {
        resolve(redirect);
      }
    });
  });
}

async function requestToken(clientId, interactive) {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "token",
    redirect_uri: getRedirectUri(),
    scope: SCOPES.join(" "),
    include_granted_scopes: "true"
  });
  if (!interactive) params.set("prompt", "none");

  const redirect = await launch(`https://accounts.google.com/o/oauth2/v2/auth?${params}`, interactive);
  const result = new URLSearchParams(new URL(redirect).hash.slice(1));
  const token = result.get("access_token");
  if (!token) throw new Error(result.get("error") || "Google did not return an access token.");
  await chrome.storage.session.set({
    auth: { token, expires: Date.now() + Number(result.get("expires_in") || 3600) * 1000 }
  });
  return token;
}

// Silent when Google already trusts this extension; opens the Google popup only when needed.
export async function getToken({ interactive = true } = {}) {
  const cached = await readCachedToken();
  if (cached) return cached;

  if (!isConfigured()) {
    throw new AuthError("Sign-in isn't available in this build yet (the developer must set CLIENT_ID in config.js).", "NOT_CONFIGURED");
  }

  try {
    return await requestToken(CLIENT_ID, false);
  } catch (error) {
    if (!interactive) throw new AuthError("Sign in with Google to continue.", "NEEDS_SIGN_IN");
    return requestToken(CLIENT_ID, true);
  }
}

export async function getAuthState() {
  if (!isConfigured()) return { configured: false, signedIn: false, redirectUri: getRedirectUri() };
  try {
    await getToken({ interactive: false });
    return { configured: true, signedIn: true };
  } catch {
    return { configured: true, signedIn: false };
  }
}

export async function signOut() {
  const { auth } = await chrome.storage.session.get("auth");
  await clearToken();
  if (auth?.token) await fetch(`https://oauth2.googleapis.com/revoke?token=${auth.token}`, { method: "POST" }).catch(() => {});
}
