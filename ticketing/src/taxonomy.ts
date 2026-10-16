import type { AccountFamily } from "./types";

// fixed intent tag taxonomy. in the full system this is config-owned;
// free intake maps to exactly one tag, unmappable goes to "other" and
// triage re-tags (the re-tag emits its own event). new tags require a
// recorded queue-mapping decision, because queue assignment is a
// function of them (see assign.ts).

export const BUYER_INTENT_TAGS = [
  "where_is_it",
  "refund_request",
  "quality_issue",
  "manufacturer_delay",
  "checkout_failure",
  "payment_declined",
  "address_rejected",
  "listing_question",
  "account_access",
  "other",
] as const;

export const CREATOR_INTENT_TAGS = [
  "payout_issue",
  "listing_release_problem",
  "order_fulfillment",
  "refund_dispute",
  "how_to",
  "clarification",
  "account_access",
  "other",
] as const;

// tags valid for both families
const SHARED_TAGS: ReadonlySet<string> = new Set(["account_access", "other"]);

// creator money-adjacent set: any of these routes to creator_support
// even with no order attached.
export const CREATOR_MONEY_ADJACENT_TAGS: ReadonlySet<string> = new Set([
  "payout_issue",
  "listing_release_problem",
  "order_fulfillment",
  "refund_dispute",
]);

export type IntentTag =
  | (typeof BUYER_INTENT_TAGS)[number]
  | (typeof CREATOR_INTENT_TAGS)[number];

export function isIntentTag(tag: string): tag is IntentTag {
  return (
    (BUYER_INTENT_TAGS as readonly string[]).includes(tag) ||
    (CREATOR_INTENT_TAGS as readonly string[]).includes(tag)
  );
}

// a tag is valid for a family when it is shared, or scoped to that
// family. cross-family tags are a mapping error and must fail loudly
// rather than silently misroute.
export function isIntentTagForFamily(family: AccountFamily, tag: string): boolean {
  if (SHARED_TAGS.has(tag)) return true;
  return family === "buyer"
    ? (BUYER_INTENT_TAGS as readonly string[]).includes(tag)
    : (CREATOR_INTENT_TAGS as readonly string[]).includes(tag);
}
