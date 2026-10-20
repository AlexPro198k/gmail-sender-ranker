const EMAIL_PROVIDER_NAMES = new Set([
  "gmail", "googlemail", "yahoo", "ymail", "outlook", "hotmail", "live", "msn",
  "icloud", "me", "mac", "aol", "proton", "protonmail", "zoho", "fastmail",
  "tutanota", "gmx", "yandex"
]);

const PROMO_TOKENS = new Set([
  "noreply", "no-reply", "donotreply", "newsletter", "news", "promo",
  "promotions", "deals", "offer", "offers", "marketing", "info", "hello",
  "support", "notifications", "notify", "alert", "alerts", "updates",
  "mailer", "bounce", "reply", "auto", "automated", "system", "service", "billing"
]);

const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "com.au", "net.au", "org.au",
  "co.nz", "org.nz", "co.jp", "co.in", "firm.in", "net.in", "org.in",
  "com.hk", "net.hk", "org.hk", "com.sg", "net.sg", "org.sg", "com.my",
  "com.ph", "com.tw", "com.cn", "com.br", "com.mx", "com.tr", "com.ar",
  "com.pl", "co.za"
]);

const BRAND_NAMES = new Map([["ebay", "eBay"], ["att", "AT&T"], ["usbank", "U.S. Bank"]]);

function domainRoot(domain) {
  const labels = domain.toLowerCase().replace(/\.$/, "").split(".").filter(Boolean);
  if (labels.length < 2) return "";
  const suffix = labels.slice(-2).join(".");
  const stateGov = /^[a-z]{2}\.gov$/.test(suffix);
  const labelCount = MULTI_LABEL_SUFFIXES.has(suffix) || stateGov ? 3 : 2;
  return labels.slice(-labelCount).join(".");
}

function mailboxName(sender) {
  const local = sender.email.split("@")[0];
  return local.replace(/[._+-]+/g, " ").trim() || sender.name || local;
}

function isPromo(sender) {
  const tokens = `${sender.email.split("@")[0]} ${sender.name || ""}`
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[\s._\-@+]+/)
    .filter(Boolean);
  return tokens.some((token) => PROMO_TOKENS.has(token));
}

function formatBrandName(brand) {
  if (BRAND_NAMES.has(brand)) return BRAND_NAMES.get(brand);
  return brand.split("-").map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
}

export function buildAutoRuleSuggestions(list) {
  const groups = new Map();

  for (const sender of list) {
    const email = String(sender.email || "").trim().toLowerCase();
    const at = email.lastIndexOf("@");
    if (at < 1 || at === email.length - 1) continue;

    const host = email.slice(at + 1);
    const root = domainRoot(host);
    if (!root) continue;

    if (EMAIL_PROVIDER_NAMES.has(root.split(".")[0])) {
      const key = `mailbox:${email}`;
      if (!groups.has(key)) {
        groups.set(key, {
          brand: mailboxName(sender),
          group: [],
          action: "folder",
          folderName: mailboxName(sender),
          totalCount: 0,
          matchEmails: [email]
        });
      }
      const suggestion = groups.get(key);
      suggestion.group.push(sender);
      suggestion.totalCount += sender.count || 0;
      continue;
    }

    const brand = root.split(".")[0].replace(/[-_](mail|email|emails|messaging|notify|alerts?)$/, "");
    if (brand.length < 4 && !BRAND_NAMES.has(brand) && !root.endsWith(".gov")) continue;

    const key = `brand:${brand}`;
    if (!groups.has(key)) {
      groups.set(key, {
        brand,
        group: [],
        action: "folder",
        folderName: root.endsWith(".gov") ? sender.name || formatBrandName(brand) : formatBrandName(brand),
        totalCount: 0,
        matchDomains: new Set()
      });
    }
    const suggestion = groups.get(key);
    suggestion.group.push(sender);
    suggestion.matchDomains.add(root);
    suggestion.totalCount += sender.count || 0;
  }

  const suggestions = [];
  for (const suggestion of groups.values()) {
    const promoCount = suggestion.group.filter(isPromo).length;
    const isMailbox = Boolean(suggestion.matchEmails);
    if (isMailbox) {
      if (suggestion.totalCount < 3 && promoCount === 0) continue;
    } else if (suggestion.group.length < 2 && suggestion.totalCount < 2 && promoCount === 0) {
      continue;
    }

    suggestion.action = promoCount === suggestion.group.length ? "block" : "folder";
    if (suggestion.matchDomains) suggestion.matchDomains = [...suggestion.matchDomains];
    suggestions.push(suggestion);
  }

  return suggestions.sort((a, b) => b.totalCount - a.totalCount);
}
