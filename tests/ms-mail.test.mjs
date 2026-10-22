import assert from "node:assert/strict";
import { scanInbox, listSubjects, listSpamMessages, getMessageContent, applyRule, trashInboxOlderThan, emptyFolder } from "../ms-mail.js";

function makeGraph(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace("/v1.0", ""));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", path, query: Object.fromEntries(u.searchParams), body, headers: init.headers });
    const out = routes(init.method || "GET", path, body, u);
    return { ok: out.status < 400, status: out.status, headers: new Map(), text: async () => (out.data ? JSON.stringify(out.data) : "") };
  };
  return { calls, fetchImpl };
}
const batchOk = (body) => ({ status: 200, data: { responses: body.requests.map((r) => ({ id: r.id, status: 200 })) } });

{
  const { fetchImpl } = makeGraph((m, p, b, u) => {
    if (u.searchParams.get("$skip")) return { status: 200, data: { value: [{ from: { emailAddress: { name: "B", address: "B@x.com" } } }] } };
    return { status: 200, data: {
      value: [{ from: { emailAddress: { name: "A", address: "a@x.com" } } }, { from: { emailAddress: { name: "B", address: "b@x.com" } } }],
      "@odata.nextLink": "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=2"
    } };
  });
  const r = await scanInbox("t", () => {}, fetchImpl);
  assert.equal(r.messagesScanned, 3);
  assert.deepEqual(r.senders.map((s) => [s.email, s.count]), [["b@x.com", 2], ["a@x.com", 1]]);
}

{
  const { fetchImpl, calls } = makeGraph(() => ({ status: 200, data: { value: [
    { id: "old-id", subject: "Old", receivedDateTime: "2024-01-01T00:00:00Z" },
    { id: "new-id", subject: "", receivedDateTime: "2025-01-01T00:00:00Z" }] } }));
  const r = await listSubjects("t", "a@x.com", 100, fetchImpl);
  assert.deepEqual(r.subjects.map((s) => s.subject), ["(no subject)", "Old"]);
  assert.deepEqual(r.subjects.map((s) => s.id), ["new-id", "old-id"]);
  assert.match(calls[0].query.$select, /id/);
  assert.match(calls[0].query.$filter, /from\/emailAddress\/address eq 'a@x\.com'/);
}

{
  const { fetchImpl, calls } = makeGraph(() => ({ status: 200, data: { value: [
    { id: "s1", subject: "Older spam", receivedDateTime: "2025-01-01T00:00:00Z", from: { emailAddress: { address: "one@example.com" } } },
    { id: "s2", subject: "Newer spam", receivedDateTime: "2025-02-01T00:00:00Z", from: { emailAddress: { name: "Two", address: "two@example.com" } } }
  ] } }));
  const result = await listSpamMessages("t", 10, fetchImpl);
  assert.deepEqual(result.messages.map((message) => [message.id, message.subject, message.from]), [
    ["s2", "Newer spam", "Two <two@example.com>"],
    ["s1", "Older spam", "one@example.com"]
  ]);
  assert.match(calls[0].path, /\/me\/mailFolders\/junkemail\/messages$/);
  assert.equal(calls[0].query.$orderby, "receivedDateTime desc");
}

{
  const { fetchImpl, calls } = makeGraph((m, p) => {
    assert.equal(p, "/me/messages/message-id");
    return { status: 200, data: {
      id: "message-id",
      subject: "Full message",
      from: { emailAddress: { name: "Sender", address: "sender@example.com" } },
      toRecipients: [{ emailAddress: { name: "Reader", address: "reader@example.com" } }],
      ccRecipients: [{ emailAddress: { address: "copy@example.com" } }],
      receivedDateTime: "2025-01-01T00:00:00Z",
      body: { contentType: "html", content: "<p>Hello &amp; welcome</p><script>bad()</script>" }
    } };
  });
  const result = await getMessageContent("t", "message-id", fetchImpl);
  assert.deepEqual(result, {
    id: "message-id",
    from: "Sender <sender@example.com>",
    to: "Reader <reader@example.com>",
    cc: "copy@example.com",
    subject: "Full message",
    date: "2025-01-01T00:00:00Z",
    body: "Hello & welcome",
    bodyHtml: "<p>Hello &amp; welcome</p><script>bad()</script>"
  });
  assert.equal(calls[0].headers.Prefer, 'outlook.body-content-type="html"');
  await assert.rejects(() => getMessageContent("t", "", fetchImpl), /message ID/);
}

{
  const { fetchImpl, calls } = makeGraph((m, p, b) => {
    if (p === "/$batch") return batchOk(b);
    return { status: 200, data: { value: [{ id: "1" }, { id: "2" }] } };
  });
  const r = await trashInboxOlderThan("t", 3, fetchImpl);
  assert.equal(r.trashed, 2);
  assert.match(calls[0].query.$filter, /^receivedDateTime lt /);
  const batch = calls.find((c) => c.path === "/$batch");
  assert.equal(batch.body.requests[0].body.destinationId, "deleteditems");
  await assert.rejects(() => trashInboxOlderThan("t", 2, fetchImpl));
}

{
  const { fetchImpl, calls } = makeGraph((m, p, b) => {
    if (p === "/me") return { status: 200, data: { mail: "me@outlook.com" } };
    if (p === "/me/mailFolders/deleteditems") return { status: 200, data: { id: "TRASH" } };
    if (p === "/me/mailFolders/inbox/messageRules") return m === "GET" ? { status: 200, data: { value: [] } } : { status: 201, data: {} };
    if (p === "/me/messages") return { status: 200, data: { value: [{ id: "m1", parentFolderId: "INBOX" }, { id: "m2", parentFolderId: "TRASH" }] } };
    if (p === "/$batch") return batchOk(b);
    throw new Error(`unexpected ${m} ${p}`);
  });
  const r = await applyRule("t", "delete", "spam@x.com", fetchImpl);
  assert.deepEqual([r.filterCreated, r.trashed], [true, 1]);
  const rule = calls.find((c) => c.method === "POST" && c.path.endsWith("messageRules"));
  assert.equal(rule.body.actions.delete, true);
  await assert.rejects(() => applyRule("t", "delete", "me@outlook.com", fetchImpl), /own address/);
}

{
  let served = false;
  const { fetchImpl } = makeGraph((m, p, b) => {
    if (p === "/$batch") return batchOk(b);
    if (served) return { status: 200, data: { value: [] } };
    served = true;
    return { status: 200, data: { value: [{ id: "x" }] } };
  });
  assert.equal((await emptyFolder("t", "trash", fetchImpl)).deleted, 1);
}
