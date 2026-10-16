import type {
  AssignmentDecision,
  AssignmentInputs,
  QueueId,
} from "./types";
import { CREATOR_MONEY_ADJACENT_TAGS, isIntentTagForFamily } from "./taxonomy";
import { deepFreeze } from "./events";

// the pure queue assignment function. a function of (account family,
// order attachment, intent tag) plus the payout-context boolean
// captured at intake - never a judgment call, never an llm in the
// path. every decision is logged with its inputs on the ticket's
// first event, so misroutes are auditable.

export class AssignmentError extends Error {}

export function assignQueue(inputs: AssignmentInputs): AssignmentDecision {
  if (!isIntentTagForFamily(inputs.account_family, inputs.intent_tag)) {
    throw new AssignmentError(
      `intent tag "${inputs.intent_tag}" is not valid for family "${inputs.account_family}"`,
    );
  }
  const frozen = deepFreeze({ ...inputs });

  if (inputs.account_family === "buyer") {
    return inputs.order_attached
      ? { queue: "buyer", rule: "buyer + order attached", inputs: frozen }
      : { queue: "buyer_to_be", rule: "buyer + no order attached", inputs: frozen };
  }

  // creator: anything money-adjacent routes to creator_support.
  // order attachment is a property of the contact, not the account.
  const moneyAdjacent =
    inputs.order_attached ||
    inputs.payout_context_present ||
    CREATOR_MONEY_ADJACENT_TAGS.has(inputs.intent_tag);
  return moneyAdjacent
    ? {
        queue: "creator_support",
        rule: "creator + order or payout context or money-adjacent tag",
        inputs: frozen,
      }
    : {
        queue: "creator_question",
        rule: "creator + nothing money-adjacent",
        inputs: frozen,
      };
}

// convenience for callers that only need the queue
export function assign(inputs: AssignmentInputs): QueueId {
  return assignQueue(inputs).queue;
}
