# sculptura support ticketing queue system: build spec

(verbatim owner spec, 2026-10-15. the architecture extends this in
`architecture.md`.)

## context (read first, the other systems assume it)

sculptura is a jewelry creation platform + marketplace. two account
families, strictly separated, never merged:

- **buyers**: identified by **bin** (the buyer-side analogue of cin).
  buyers purchase through a multi-store checkout: one payment can
  span multiple creators, creating n orders, each with its own
  escrow hold. refunds are per order, never cart-wide.
- **creators** (artists with marketplace entry): identified by
  **cin**; their shops carry **sin**. creators get paid on the 15th
  of each month from escrow.

terminology is fixed: markets and territories, always
**iso 3166-1 alpha-2** codes in internal data; never the word
"country" in user-facing strings.

support is **deflection-first**: most demand should never reach a
human. this system is the human tail. the deflectors (onboarding
packet, creator docs, knowledgebase, sculptura academy, retelldb
lookup layer) are separate systems; this spec only consumes their
interfaces.

## scope

build the ticketing queue system only: intake, deflection handoff,
queueing, routing, human agent workspace, resolution, and
measurement. not in scope: retelldb/kb/docs authoring, payout
execution, moderation verdicts, phone/voice channel.

## queue taxonomy

four queues, assigned by a pure function of (account family, order
attachment, intent tag) - never a judgment call:

1. **buyer queue** (has already purchased): order-attached. where-is-it,
   refund requests, manufacturer delays, quality issues.
2. **buyer-to-be queue** (facing issues placing an order): checkout
   failures, declined payments, address rejections, question about
   a listing before buying.
3. **creator queue (support)**: payout issues, listing/release
   problems, order fulfillment, money-adjacent. order or payout
   context attached.
4. **creator queue (question)**: how-to and clarification, no order
   attached. routed here when nothing money-adjacent is referenced.

queue assignment is logged with its inputs so misroutes are
auditable.

## case + ticket model

every contact creates a **case** first. deflection runs on the case.
only unresolved cases become **tickets**.

case fields: id, account ref (bin or cin), market (iso 3166-1
alpha-2), language, source channel (web form, in-app, email),
intent tag (free intake, mapped to a fixed taxonomy), deflection
attempts (list), created_at.

ticket fields: case ref, queue, priority (see routing), order refs
(0..n), linked order segments, escrow state snapshot, payout
schedule snapshot (creator queues), deflection history summary,
assigned agent, state, events.

## intake and deflection handoff

- every intake point (web form, in-app contact, email in) creates a
  case and attempts deflection in order: **retelldb lookup** first
  (pass the case text, market, language; receive suggested answers
  + doc/kb/academy deep links), then a deflection screen with the
  suggestions and relevant deep links.
- deflection attempts are logged on the case: what was offered, in
  what order, and whether the user marked it resolved or proceeded.
- unresolved, or an explicit "still need a human" click, creates the
  ticket in the assigned queue. exactly one explicit click is
  allowed to reach a human: never a maze, never more than one
  confirm step.
- email intake: address must pass the email eligibility gate
  (themailtell adapter); phone contact points show line-type
  verification state (thephonetell); shipping-address disputes show
  the address-shape verdict (thelocaletell; the po-box ban lives
  there, not here).

## routing and workload distribution

- routing keys: queue type, market, language. tickets route to
  agents assigned to that (queue, market, language) set;
  round-robin within a queue with per-agent concurrency caps.
- priority: age-based, plus order value visible as context only.
  never priority from trust, spend history, or fraud flags - those
  are context, not ranking inputs.
- burst mode: queues accept a configurable burst multiplier. known
  spike windows: the 15th (payout day, creator queues) and drop
  windows. burst mode changes concurrency caps, never priority
  rules.

## state machine

new -> triaged -> in_progress -> waiting_on_user -> resolved ->
closed. reopen within 14 days: creates a linked new ticket that
inherits the event history by reference.

every state change, note, deflection, response, and assignment is an
append-only event on the ticket. no silent edits, no event
mutation. agents cannot delete events.

## human agent workspace

- ticket view: identity panel (bin/cin, verification badges),
  order context (segments, escrow state), payout schedule (creator
  support only), market + language, full deflection history,
  retelldb suggested answers as drafts. suggestions are drafts only:
  the agent owns what gets sent.
- response library: canned answers must reference doc/kb/academy
  entries by link. no free-text knowledge lives only in canned
  responses; the kb is the single source of truth.
- escalation: escalate to a senior queue on the same event chain.
- money actions: support can propose refunds and payout
  investigations; the payments system executes them. the ticket view
  has no money-moving controls. refund proposals carry order refs
  and post back the result as a ticket event.

## anti-abuse

- per-account ticket rate limits per queue per day, config-driven.
- duplicate merge: same account + same intent tag within a
  configurable window merges into the open ticket.
- abuse reports filed from tickets route to the moderation layer as
  signals, never verdicts; support never enforces.
- vpn or fraud flags render as context chips only, never
  auto-priority, never queue assignment.
