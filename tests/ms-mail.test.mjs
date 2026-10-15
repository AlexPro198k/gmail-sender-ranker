import assert from "node:assert/strict";
import { scanInbox, listSubjects, applyRule, trashInboxOlderThan, emptyFolder } from "../ms-mail.js";

function makeGraph(routes) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const path = decodeURIComponent(u.pathname.replace("/v1.0", ""));
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || "GET", path, query: Object.fromEntries(u.searchParams), body });
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
    { subject: "Old", receivedDateTime: "2024-01-01T00:00:00Z" }, { subject: "", receivedDateTime: "2025-01-01T00:00:00Z" }] } }));
  const r = await listSubjects("t", "a@x.com", 100, fetchImpl);
  assert.deepEqual(r.subjects.map((s) => s.subject), ["(no subject)", "Old"]);
  assert.match(calls[0].query.$filter, /from\/emailAddress\/address eq 'a@x\.com'/);
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
