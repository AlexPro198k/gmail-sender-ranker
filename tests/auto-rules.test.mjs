import assert from "node:assert/strict";
import { buildAutoRuleSuggestions } from "../mobile/auto-rules.js";

const senders = [
  { name: "eBay - seller1", email: "seller1@members.ebay.com.hk", count: 4 },
  { name: "eBay - seller2", email: "seller2@members.ebay.ca", count: 3 },
  { name: "eBay - seller3", email: "seller3@members.ebay.com", count: 2 },
  { name: "Alex P", email: "AlexP@gmail.com", count: 8 },
  { name: "Sam", email: "sam@gmail.com", count: 5 },
  { name: "AT&T", email: "emailff@att-mail.com", count: 2 },
  { name: "AT&T Account Management", email: "account@att-mail.com", count: 2 },
  { name: "WA Department of Licensing", email: "notice@notifications.dol.wa.gov", count: 2 }
];

const suggestions = buildAutoRuleSuggestions(senders);
const ebay = suggestions.find((suggestion) => suggestion.folderName === "eBay");
assert.ok(ebay);
assert.equal(ebay.group.length, 3);
assert.deepEqual(new Set(ebay.matchDomains), new Set(["ebay.com.hk", "ebay.ca", "ebay.com"]));
assert.equal(ebay.action, "folder");

const alex = suggestions.find((suggestion) => suggestion.folderName === "AlexP");
assert.ok(alex);
assert.deepEqual(alex.matchEmails, ["alexp@gmail.com"]);
assert.equal(alex.matchDomains, undefined);
assert.equal(alex.group.length, 1);
assert.ok(suggestions.some((suggestion) => suggestion.folderName === "sam"));

const att = suggestions.find((suggestion) => suggestion.folderName === "AT&T");
assert.ok(att);
assert.deepEqual(att.matchDomains, ["att-mail.com"]);
assert.ok(suggestions.some((suggestion) => suggestion.group.some((sender) => sender.email === "notice@notifications.dol.wa.gov")));

console.log("All auto-rules tests passed.");
