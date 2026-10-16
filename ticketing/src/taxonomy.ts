import type { AccountFamily, ContactKind, IssueSubject, TicketKind } from "./types";

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
  "idv_pending",
  "idv_rejected",
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

// idv (identity verification) gates payouts, so idv issues sit beside
// payout issues in creator_support but keep their own subject - a
// "payout failed" ticket that is really an idv hold stays measurable
// instead of confounded (owner ruling 2026-10-16).
export const CREATOR_IDV_TAGS: ReadonlySet<string> = new Set([
  "idv_pending",
  "idv_rejected",
]);

// creator account issues are issues, not questions: account-blocking
// matters route to creator_support even with no order or payout
// context attached (owner ruling 2026-10-16). buyer account issues
// stay pure: they route by order attachment.
export const CREATOR_ACCOUNT_ISSUE_TAGS: ReadonlySet<string> = new Set([
  "account_access",
]);

// question tags: kind derivation when the contact does not declare
// its kind. the kind axis is family-orthogonal; both families can
// ask questions.
const QUESTION_TAGS: ReadonlySet<string> = new Set([
  "how_to",
  "clarification",
  "listing_question",
]);

// subject derivation: what an issue is with respect to. recorded on
// the assignment event, never a routing input.
const CREATOR_SUBJECTS: ReadonlyMap<string, IssueSubject> = new Map([
  ["payout_issue", "payout"],
  ["idv_pending", "idv"],
  ["idv_rejected", "idv"],
  ["listing_release_problem", "listing_release"],
  ["order_fulfillment", "fulfillment"],
  ["refund_dispute", "fulfillment"],
  ["account_access", "account"],
  ["other", "other"],
]);

const BUYER_SUBJECTS: ReadonlyMap<string, IssueSubject> = new Map([
  ["where_is_it", "order"],
  ["refund_request", "order"],
  ["quality_issue", "order"],
  ["manufacturer_delay", "order"],
  ["checkout_failure", "checkout"],
  ["payment_declined", "checkout"],
  ["address_rejected", "checkout"],
  ["listing_question", "checkout"],
  ["account_access", "account"],
  ["other", "other"],
]);

export function subjectOf(family: AccountFamily, intentTag: string): IssueSubject | null {
  // questions carry no subject: the axis is for issues only
  if (QUESTION_TAGS.has(intentTag)) return null;
  const map = family === "buyer" ? BUYER_SUBJECTS : CREATOR_SUBJECTS;
  return map.get(intentTag) ?? "other";
}

// kind derivation at intake. an explicitly declared kind wins;
// otherwise the tag decides (how-to/clarification/listing questions
// are questions); a ticketable default keeps intake honest.
export function kindOf(input: {
  account_family: AccountFamily;
  intent_tag: string;
  kind?: ContactKind;
}): ContactKind {
  if (input.kind) return input.kind;
  if (QUESTION_TAGS.has(input.intent_tag)) return "question";
  return "support_issue";
}

export function isTicketableKind(kind: ContactKind): kind is TicketKind {
  return kind === "support_issue" || kind === "question";
}

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
