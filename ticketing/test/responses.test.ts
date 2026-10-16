import { test } from "node:test";
import assert from "node:assert/strict";
import { ResponseLibrary, ResponseLibraryError, respondFromLibrary } from "../src/responses";
import { SupportService, ContactInput } from "../src/support";
import type { ResponseLibraryEntry } from "../src/types";

const T0 = "2026-10-16T00:00:00.000Z";
const at = (minutes: number) =>
  new Date(Date.parse(T0) + minutes * 60_000).toISOString();

function mkContact(over: Partial<ContactInput> = {}): ContactInput {
  return {
    account_family: "buyer",
    account_ref: "bin_1",
    market: "US",
    language: "en-US",
    source_channel: "web_form",
    subject: "help",
    body: "i need help",
    intent_tag: "where_is_it",
    order_attached: true,
    ...over,
  };
}

const mkEntry = (over: Partial<ResponseLibraryEntry> = {}): ResponseLibraryEntry => ({
  id: "resp_1",
  queue: "buyer",
  body: "your order ships within 3 business days. details: https://kb.sculptura.com/shipping",
  links: [{ source: "kb", url: "https://kb.sculptura.com/shipping" }],
  ...over,
});

const worked = (svc: SupportService, ticketId: string) => {
  svc.triage(ticketId, "agent_1", at(1));
  svc.start(ticketId, "agent_1", at(2));
};

test("library entries save only with a valid doc/kb/academy link", () => {
  const lib = new ResponseLibrary();
  lib.save(mkEntry());
  assert.equal(lib.get("resp_1")?.id, "resp_1");

  // no link: free-text knowledge cannot live only here
  assert.throws(() => lib.save(mkEntry({ id: "no_links", links: [] })), ResponseLibraryError);
  // not https
  assert.throws(
    () => lib.save(mkEntry({ id: "http", links: [{ source: "kb", url: "http://kb.sculptura.com/x" }] })),
    ResponseLibraryError,
  );
  // not a content host
  assert.throws(
    () => lib.save(mkEntry({ id: "offhost", links: [{ source: "kb", url: "https://example.com/x" }] })),
    ResponseLibraryError,
  );
  // not a url
  assert.throws(
    () => lib.save(mkEntry({ id: "junk", links: [{ source: "kb", url: "not a url" }] })),
    ResponseLibraryError,
  );
  // empty body
  assert.throws(() => lib.save(mkEntry({ id: "empty", body: "  " })), ResponseLibraryError);
});

test("entries are scoped by queue and optionally market/language", () => {
  const svc = new SupportService();
  const lib = new ResponseLibrary();
  lib.save(mkEntry()); // buyer, any market
  lib.save(mkEntry({ id: "resp_de", market: "DE", language: "de-DE" }));
  lib.save(mkEntry({ id: "resp_creator", queue: "creator_question" }));

  const t = svc.receiveContact(mkContact(), T0);
  if (t.kind !== "ticketed") throw new Error("expected ticketed");
  const usable = lib.listForTicket(svc, t.ticket.id);
  assert.deepEqual(usable.map((e) => e.id), ["resp_1"]);

  const de = svc.receiveContact(mkContact({ market: "DE", language: "de-DE", account_ref: "bin_2" }), T0);
  if (de.kind !== "ticketed") throw new Error("expected ticketed");
  assert.deepEqual(
    lib.listForTicket(svc, de.ticket.id).map((e) => e.id),
    ["resp_1", "resp_de"],
  );
});

test("sending a library response logs the entry and its links on the ticket", () => {
  const svc = new SupportService();
  const lib = new ResponseLibrary();
  lib.save(mkEntry());
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  worked(svc, out.ticket.id);

  const updated = respondFromLibrary(svc, lib, out.ticket.id, "agent_1", "resp_1", at(3));
  assert.equal(updated.state, "waiting_on_user");
  const event = svc
    .ticketEvents(out.ticket.id)
    .find((e) => e.type === "response_sent");
  const payload = event?.payload as { entry_id?: string; links?: { url: string }[] };
  assert.equal(payload.entry_id, "resp_1");
  assert.equal(payload.links?.[0].url, "https://kb.sculptura.com/shipping");
});

test("free-text responses stay payload-lean and legal", () => {
  const svc = new SupportService();
  const out = svc.receiveContact(mkContact(), T0);
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  worked(svc, out.ticket.id);
  svc.respond(out.ticket.id, "agent_1", "plain words from the agent", at(3));
  const event = svc.ticketEvents(out.ticket.id).find((e) => e.type === "response_sent");
  assert.deepEqual(event?.payload, { body: "plain words from the agent" });
});

test("scope or existence violations fail loudly before anything sends", () => {
  const svc = new SupportService();
  const lib = new ResponseLibrary();
  lib.save(mkEntry()); // buyer queue
  const out = svc.receiveContact(
    mkContact({
      account_family: "creator",
      account_ref: "cin_1",
      intent_tag: "how_to",
      order_attached: false,
    }),
    T0,
  );
  if (out.kind !== "ticketed") throw new Error("expected ticketed");
  worked(svc, out.ticket.id); // creator_question queue

  // buyer-queue entry on a creator_question ticket: refused
  assert.throws(
    () => respondFromLibrary(svc, lib, out.ticket.id, "agent_1", "resp_1", at(3)),
    ResponseLibraryError,
  );
  // unknown entry: refused
  assert.throws(
    () => respondFromLibrary(svc, lib, out.ticket.id, "agent_1", "nope", at(3)),
    ResponseLibraryError,
  );
  // nothing was sent
  assert.ok(!svc.ticketEvents(out.ticket.id).some((e) => e.type === "response_sent"));
});
