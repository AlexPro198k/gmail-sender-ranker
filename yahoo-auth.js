import { YAHOO_CLIENT_ID } from "./config.js";

const AUTHORITY = "https://api.login.yahoo.com/oauth2";
const SCOPE = "openid email profile";
const SESSION_KEY = "yahooToken";
const PKCE_KEY = "yahooPkce";

const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const redirectUri = () => location.origin + location.pathname;

export const yahooConfigured = () => Boolean(YAHOO_CLIENT_ID);

export function cachedYahooToken() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    return saved && Date.now() < saved.expires - 60_000 ? saved : null;
  } catch {
    return null;
  }
}

export async function startYahooSignIn() {
  if (!yahooConfigured()) throw new Error("Yahoo sign-in isn't configured yet: set YAHOO_CLIENT_ID in config.js.");
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem(PKCE_KEY, JSON.stringify({ verifier, state }));
  const params = new URLSearchParams({
    client_id: YAHOO_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri(),
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    nonce: b64url(crypto.getRandomValues(new Uint8Array(16)))
  });
  location.assign(`${AUTHORITY}/request_auth?${params}`);
}

export async function finishYahooSignIn() {
  const query = new URLSearchParams(location.search);
  if (!query.has("code") && !query.has("error")) return null;
  const saved = JSON.parse(sessionStorage.getItem(PKCE_KEY) || "null");
  history.replaceState(null, "", redirectUri());
  sessionStorage.removeItem(PKCE_KEY);
  if (query.has("error")) throw new Error(query.get("error_description") || query.get("error"));
  if (!saved || saved.state !== query.get("state")) return null;

  const res = await fetch(`${AUTHORITY}/get_token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: YAHOO_CLIENT_ID,
      grant_type: "authorization_code",
      code: query.get("code"),
      redirect_uri: redirectUri(),
      code_verifier: saved.verifier
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error(data.error_description || "Yahoo sign-in failed.");

  // Decode the id_token JWT payload (no signature verification needed for display only).
  let name = "", email = "";
  try {
    const payload = JSON.parse(atob(data.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    name = payload.name || payload.given_name || "";
    email = payload.email || "";
  } catch { /* ignore */ }

  const session = { token: data.access_token, expires: Date.now() + Number(data.expires_in || 3600) * 1000, name, email };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  return session;
}

export function yahooSignOut() {
  sessionStorage.removeItem(SESSION_KEY);
}
