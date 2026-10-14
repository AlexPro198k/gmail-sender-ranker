import assert from "node:assert/strict";
import { applyRule, normalizeEmail } from "../gmail-rules.js";

function makeGmail({ labels = [], pages = [["m1", "m2"]], profile = "me@gmail.com", filterError } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const u = new URL(url);
    const path = u.pathname.replace("/gmail/v1/users/me", "");
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path, query: Object.fromEntries(u.searchParams), body });
    const reply = (status, data) => ({ ok: status < 400, status, text: async () => (data ? JSON.stringify(data) : "") });

    if (path === "/profile") return reply(200, { emailAddress: profile });
    if (path === "/labels" && init.method === "GET") return reply(200, { labels });
    if (path === "/labels") return reply(200, { id: "Label_new", name: body.name });
    if (path === "/settings/filters") return filterError ? reply(filterError.status, { error: { message: filterError.message } }) : reply(200, { id: "f1" });
    if (path === "/messages") {
      const index = Number(u.searchParams.get("pageToken") || 0);
      return reply(200, {
        messages: pages[index].map((id) => ({ id })),
        nextPageToken: index + 1 < pages.length ? String(index + 1) : undefined
      });
    }
    if (path === "/messages/batchModify") return reply(204);
    throw new Error(`Unexpected call ${init.method} ${path}`);
  };
  return { calls, fetchImpl };
}

// Delete Always: TRASH filter, then existing mail trashed across pages.
{
  const { calls, fetchImpl } = makeGmail({ pages: [["a", "b"], ["c"]] });
  const result = await applyRule("tok", "delete", "Spam@Example.com", fetchImpl);
  assert.deepEqual(result, { email: "spam@example.com", action: "delete", filterCreated: true, trashed: 3 });
  const filter = calls.find((c) => c.path === "/settings/filters");
  assert.deepEqual(filter.body, { criteria: { from: "spam@example.com" }, action: { addLabelIds: ["TRASH"] } });
  const list = calls.find((c) => c.path === "/messages");
  assert.equal(list.query.q, 'from:"spam@example.com" -in:trash');
  const batch = calls.find((c) => c.path === "/messages/batchModify");
  assert.deepEqual(batch.body, { ids: ["a", "b", "c"], addLabelIds: ["TRASH"], removeLabelIds: ["INBOX"] });
}

// Block: creates the Blocked label, filter skips inbox + marks read + labels.
{
  const { calls, fetchImpl } = makeGmail();
  const result = await applyRule("tok", "block", "x@y.com", fetchImpl);
  assert.equal(result.trashed, 2);
  assert.ok(calls.some((c) => c.path === "/labels" && c.method === "POST" && c.body.name === "Blocked"));
  const filter = calls.find((c) => c.path === "/settings/filters");
  assert.deepEqual(filter.body.action, { addLabelIds: ["Label_new"], removeLabelIds: ["INBOX", "UNREAD"] });
}

// Block reuses an existing label (case-insensitive) instead of creating one.
{
  const { calls, fetchImpl } = makeGmail({ labels: [{ id: "L9", name: "blocked" }] });
  await applyRule("tok", "block", "x@y.com", fetchImpl);
  assert.ok(!calls.some((c) => c.path === "/labels" && c.method === "POST"));
  assert.deepEqual(calls.find((c) => c.path === "/settings/filters").body.action.addLabelIds, ["L9"]);
}

// Duplicate filter is tolerated, mail is still trashed.
{
  const { fetchImpl } = makeGmail({ filterError: { status: 400, message: "Filter already exists" } });
  const result = await applyRule("tok", "delete", "x@y.com", fetchImpl);
  assert.equal(result.filterCreated, false);
  assert.equal(result.trashed, 2);
}

// Other filter failures abort before anything is trashed.
{
  const { calls, fetchImpl } = makeGmail({ filterError: { status: 403, message: "denied" } });
  await assert.rejects(applyRule("tok", "delete", "x@y.com", fetchImpl), /denied/);
  assert.ok(!calls.some((c) => c.path === "/messages/batchModify"));
}

// Large sets are batched in groups of 1000.
{
  const ids = Array.from({ length: 2500 }, (_, i) => `m${i}`);
  const { calls, fetchImpl } = makeGmail({ pages: [ids] });
  await applyRule("tok", "delete", "x@y.com", fetchImpl);
  const sizes = calls.filter((c) => c.path === "/messages/batchModify").map((c) => c.body.ids.length);
  assert.deepEqual(sizes, [1000, 1000, 500]);
}

// Safety: own address, invalid addresses, unknown action, and query-injection attempts.
{
  const { calls, fetchImpl } = makeGmail({ profile: "Me@Gmail.com" });
  await assert.rejects(applyRule("tok", "delete", "me@gmail.com", fetchImpl), /own address/);
  assert.ok(!calls.some((c) => c.path === "/settings/filters"));
}
for (const bad of ['a@b.com" OR in:inbox', "no-at-sign", "a b@c.com", "", null, "a@b"]) {
  assert.throws(() => normalizeEmail(bad), /valid email/);
}
await assert.rejects(applyRule("tok", "archive", "x@y.com", makeGmail().fetchImpl), /Unknown action/);

console.log("All gmail-rules tests passed.");
