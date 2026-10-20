import { MS_CLIENT_ID } from "./config.js";

const AUTHORITY = "https://login.microsoftonline.com/common/oauth2/v2.0";
export const MS_SCOPE = "https://graph.microsoft.com/Mail.ReadWrite https://graph.microsoft.com/MailboxSettings.ReadWrite https://graph.microsoft.com/User.Read";
const SESSION_KEY = "msToken";
const PKCE_KEY = "msPkce";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
const redirectUri = () => {
  // Strip any query string or hash — must match exactly what is registered in Entra
  return location.origin + location.pathname.replace(/\/+$/, "");
};

export const msConfigured = () => Boolean(MS_CLIENT_ID);

export function cachedMsToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return saved && Date.now() < saved.expires - 60_000 ? saved.token : null;
  } catch {
    return null;
  }
}

// Authorization code flow with PKCE: redirects to Microsoft, and finishMsSignIn() runs on return.
export async function startMsSignIn(loginHint) {
  if (!msConfigured()) throw new Error("Microsoft sign-in isn't configured yet: set MS_CLIENT_ID in config.js.");
  const uri = redirectUri();
  console.log("[ms-auth] redirect_uri being sent:", uri);
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    scope: MS_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    prompt: "select_account"
  });
  if (loginHint) params.set("login_hint", loginHint);
  location.assign(`${AUTHORITY}/authorize?${params}`);
}

// Returns a token when the page was just redirected back from Microsoft, otherwise null.
export async function finishMsSignIn() {
  const query = new URLSearchParams(location.search);
  if (!query.has("code") && !query.has("error")) return null;
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
  history.replaceState(null, "", redirectUri());
  sessionStorage.removeItem(PKCE_KEY);
  if (query.has("error")) throw new Error(query.get("error_description") || query.get("error"));
  if (!saved || saved.state !== query.get("state")) return null;

  const res = await fetch(`${AUTHORITY}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: MS_CLIENT_ID,
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier,
      scope: MS_SCOPE
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || "Microsoft sign-in failed.");
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    token: data.access_token,
    expires: Date.now() + Number(data.expires_in || 3600) * 1000
  }));
  return data.access_token;
}

export function msSignOut() {
  sessionStorage.removeItem(SESSION_KEY);
}
