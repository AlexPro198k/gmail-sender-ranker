import assert from "node:assert/strict";
import { scanInbox, parseFrom, listSubjects, getMessageContent } from "../gmail-scan.js";
import { htmlToText } from "../mail-content.js";

assert.deepEqual(parseFrom('"Chase" <Alerts@Chase.com>'), { name: "Chase", email: "alerts@chase.com" });
assert.deepEqual(parseFrom("bob@x.com"), { name: "bob@x.com", email: "bob@x.com" });
assert.equal(htmlToText("<p>Hello &amp; welcome</p><script>bad()</script>"), "Hello & welcome");

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

{
  const fetchSubjects = async (url) => {
    const u = new URL(url);
    const reply = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
    if (u.pathname.endsWith("/messages")) return reply({ messages: [{ id: "m1" }] });
    return reply({ payload: { headers: [{ name: "Subject", value: "Hello" }, { name: "Date", value: "Today" }] } });
  };
  const result = await listSubjects("tok", "sender@example.com", 10, fetchSubjects);
  assert.deepEqual(result.subjects, [{ id: "m1", subject: "Hello", date: "Today" }]);
}

{
  const plainBody = Buffer.from("Full plain-text body\nwith a second line").toString("base64url");
  const htmlBody = Buffer.from("<p>HTML fallback</p>").toString("base64url");
  let htmlOnly = false;
  const fetchMessage = async (url) => {
    const u = new URL(url);
    assert.match(u.pathname, /\/messages\/m1$/);
    assert.equal(u.searchParams.get("format"), "full");
    const headers = [
      { name: "From", value: "Sender <sender@example.com>" },
      { name: "To", value: "Reader <reader@example.com>" },
      { name: "Cc", value: "Copy <copy@example.com>" },
      { name: "Subject", value: "Full message" },
      { name: "Date", value: "Today" }
    ];
    const parts = htmlOnly
      ? [{ mimeType: "text/html", body: { data: htmlBody } }]
      : [
          { mimeType: "text/html", body: { data: htmlBody } },
          { mimeType: "text/plain", body: { data: plainBody } }
        ];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: "m1", payload: { headers, parts } })
    };
  };
  const result = await getMessageContent("tok", "m1", fetchMessage);
  assert.deepEqual(result, {
    id: "m1",
    from: "Sender <sender@example.com>",
    to: "Reader <reader@example.com>",
    cc: "Copy <copy@example.com>",
    subject: "Full message",
    date: "Today",
    body: "Full plain-text body\nwith a second line"
  });
  htmlOnly = true;
  assert.equal((await getMessageContent("tok", "m1", fetchMessage)).body, "HTML fallback");
  await assert.rejects(() => getMessageContent("tok", "", fetchMessage), /message ID/);
}

{
  const body = Buffer.from([0x63, 0x61, 0x66, 0xe9]).toString("base64url");
  const fetchMessage = async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({
      payload: {
        parts: [{
          mimeType: "text/plain",
          headers: [{ name: "Content-Type", value: 'text/plain; charset="windows-1252"' }],
          body: { data: body }
        }]
      }
    })
  });
  assert.equal((await getMessageContent("tok", "legacy", fetchMessage)).body, "caf\u00e9");
}

console.log("gmail-scan tests passed.");
