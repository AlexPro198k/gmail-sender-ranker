import assert from "node:assert/strict";
import { scanInbox, parseFrom } from "../gmail-scan.js";

assert.deepEqual(parseFrom('"Chase" <Alerts@Chase.com>'), { name: "Chase", email: "alerts@chase.com" });
assert.deepEqual(parseFrom("bob@x.com"), { name: "bob@x.com", email: "bob@x.com" });

const froms = { a: "A <a@x.com>", b: "A <a@x.com>", c: "C <c@x.com>", d: "A <a@x.com>" };
let flaky = true;
const fetchImpl = async (url) => {
  const u = new URL(url);
  const reply = (status, data) => ({ ok: status < 400, status, text: async () => JSON.stringify(data) });
  if (u.pathname.endsWith("/messages")) {
    return u.searchParams.get("pageToken")
      ? reply(200, { messages: [{ id: "d" }] })
      : reply(200, { messages: [{ id: "a" }, { id: "b" }, { id: "c" }], nextPageToken: "2" });
  }
  const id = u.pathname.split("/").pop();
  if (id === "a" && flaky) { flaky = false; return reply(429, { error: { message: "rate" } }); }
  return reply(200, { payload: { headers: [{ name: "From", value: froms[id] }] } });
};

const { senders, messagesScanned } = await scanInbox("tok", () => {}, fetchImpl);
assert.equal(messagesScanned, 4);
assert.deepEqual(senders.map((s) => [s.email, s.count]), [["a@x.com", 3], ["c@x.com", 1]]);
console.log("gmail-scan tests passed.");
