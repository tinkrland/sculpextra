import { test } from "node:test";
import assert from "node:assert/strict";
import { assignQueue, AssignmentError, assign } from "../src/assign";
import { BUYER_INTENT_TAGS, CREATOR_INTENT_TAGS } from "../src/taxonomy";

const inputs = (over: Partial<Parameters<typeof assignQueue>[0]> = {}) => ({
  account_family: "buyer" as const,
  order_attached: false,
  payout_context_present: false,
  intent_tag: "other",
  ...over,
});

test("every buyer tag with an order attached routes to the buyer queue", () => {
  for (const tag of BUYER_INTENT_TAGS) {
    const d = assignQueue(inputs({ intent_tag: tag, order_attached: true }));
    assert.equal(d.queue, "buyer", `tag ${tag}`);
  }
});

test("every buyer tag without an order routes to buyer_to_be", () => {
  for (const tag of BUYER_INTENT_TAGS) {
    const d = assignQueue(inputs({ intent_tag: tag, order_attached: false }));
    assert.equal(d.queue, "buyer_to_be", `tag ${tag}`);
  }
});

test("a buyer asking about a failed new checkout lands in buyer_to_be", () => {
  // order attachment is a property of the contact, not the account:
  // past orders do not count
  const d = assignQueue(inputs({ intent_tag: "checkout_failure", order_attached: false }));
  assert.equal(d.queue, "buyer_to_be");
});

test("creator money-adjacent, idv, and account-blocking tags route to creator_support with no order", () => {
  // owner ruling 2026-10-16: idv gates payouts (sits beside payout
  // issues), and creator account issues are issues, not questions.
  for (const tag of [
    "payout_issue",
    "listing_release_problem",
    "order_fulfillment",
    "refund_dispute",
    "idv_pending",
    "idv_rejected",
    "account_access",
  ]) {
    const d = assignQueue(inputs({ account_family: "creator", intent_tag: tag }));
    assert.equal(d.queue, "creator_support", `tag ${tag}`);
  }
});

test("creator how-to tags with nothing money-adjacent route to creator_question", () => {
  for (const tag of ["how_to", "clarification", "other"]) {
    const d = assignQueue(inputs({ account_family: "creator", intent_tag: tag }));
    assert.equal(d.queue, "creator_question", `tag ${tag}`);
  }
});

test("creator how_to with payout context routes to creator_support", () => {
  const d = assignQueue(inputs({ account_family: "creator", intent_tag: "how_to", payout_context_present: true }));
  assert.equal(d.queue, "creator_support");
});

test("creator how_to with an order attached routes to creator_support", () => {
  const d = assignQueue(inputs({ account_family: "creator", intent_tag: "how_to", order_attached: true }));
  assert.equal(d.queue, "creator_support");
});

test("cross-family tags are rejected loudly", () => {
  assert.throws(
    () => assignQueue(inputs({ account_family: "buyer", intent_tag: "payout_issue" })),
    AssignmentError,
  );
  assert.throws(
    () => assignQueue(inputs({ account_family: "creator", intent_tag: "checkout_failure" })),
    AssignmentError,
  );
});

test("unknown tags are rejected", () => {
  assert.throws(() => assignQueue(inputs({ intent_tag: "nonsense" })), AssignmentError);
  assert.throws(() => assignQueue(inputs({ intent_tag: "Where_Is_It" })), AssignmentError);
});

test("decision inputs are frozen and every decision names its rule", () => {
  const d = assignQueue(inputs({ intent_tag: "where_is_it", order_attached: true }));
  assert.throws(() => {
    (d.inputs as { intent_tag: string }).intent_tag = "other";
  });
  assert.equal(d.inputs.intent_tag, "where_is_it");
  assert.ok(d.rule.length > 0);
});

test("assign convenience helper returns the queue", () => {
  assert.equal(assign(inputs({ intent_tag: "refund_request", order_attached: true })), "buyer");
});

test("every taxonomy tag routes without throwing for its own family", () => {
  for (const tag of BUYER_INTENT_TAGS) {
    assert.ok(["buyer", "buyer_to_be"].includes(assign(inputs({ intent_tag: tag, order_attached: true }))));
  }
  for (const tag of CREATOR_INTENT_TAGS) {
    assert.ok(
      ["creator_support", "creator_question"].includes(
        assign(inputs({ account_family: "creator", intent_tag: tag })),
      ),
    );
  }
});
