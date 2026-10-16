# sculptura support ticketing: system architecture + flow + process

extends the build spec (`specs/build-spec.md`). implementation-neutral: the
event-sourced core is storage-portable, every external dependency sits behind
an interface. terminology is fixed as in the build spec: **bin** (buyer id),
**cin** (creator id), **sin** (shop id), markets and territories as **iso
3166-1 alpha-2**, never the word "country" in user-facing strings.

## 1. system architecture

```
                            ┌─────────────────────────────────────────┐
  web form ─┐               │           intake service                 │
  in-app  ──┤               │  normalize → gates → retelldb lookup      │
  email  ───┘── (themailtell ─┘ eligibility gate, email only)          │
                            └───────────────┬─────────────────────────┘
                                            │ case (append-only events)
                            ┌───────────────▼─────────────────────────┐
                            │        deflection screen                  │
                            │  suggestions + deep links, ONE            │
                            │  "still need a human" click              │
                            └──────┬──────────────────────┬───────────┘
                             resolved                     proceeded
                                  │                            │
                            (case closed)          ┌─────────▼──────────┐
                                                  │ queue assignment fn │
                                                  │ (pure, inputs logged)│
                                                  └─────────┬──────────┘
                                                            │ ticket
                            ┌───────────────┬───────────────▼───────────┐
                            │ routing svc   │ ticket svc (event-sourced, │
                            │ (queue,market,│ state machine, merge,      │
                            │  language)    │ reopen, event log)        │
                            └───────┬───────└───────────┬───────────────┘
                                    │                 │
                            ┌───────▼─────────────────▼───────────────┐
                            │        agent workspace (read + propose)  │
                            └───────┬─────────────────────────────────┘
                                    │ proposals only, never money moves
                            ┌───────▼─────────────────────────────────┐
                            │ proposal bridge → payments system         │
                            │ (executes; result posts back as event)    │
                            └───────────────────────────────────────────┘

  consumed interfaces (all behind adapters): retelldb lookup, themailtell,
  thephonetell, thelocaletell, orders/escrow, payout schedule, identity,
  moderation layer. produced signals: abuse reports → moderation.
```

components:

- **intake service.** one case per contact, from any channel adapter.
  normalizes account family + ref (bin/cin), market (iso 3166-1 alpha-2),
  language, intent tag. runs gates. calls retelldb. renders the deflection
  screen. never decides queues itself.
- **deflection pipeline.** retelldb lookup first (case text, market,
  language → suggested answers + doc/kb/academy deep links), then one
  deflection screen. exactly one explicit click reaches a human. every
  offer, ordering, and outcome is logged on the case.
- **queue assignment function.** pure function of (account family, order
  attachment, intent tag). inputs + output logged on the ticket as its
  first event so misroutes are auditable. no judgment calls, no LLM in
  the path.
- **routing service.** key = (queue, market, language). round-robin over
  agents assigned that set, per-agent concurrency caps, burst multipliers.
- **ticket service.** event-sourced tickets: state machine, append-only
  event log, duplicate merge, reopen linking, escalation on the same
  chain.
- **agent workspace.** read-and-propose UI. zero money-moving controls.
- **proposal bridge.** refund proposals and payout investigations go to
  the payments system; execution results post back as ticket events.
- **measurement job.** aggregate from case + ticket events only. no
  separate tracking pipeline to drift out of sync.

## 2. data model

all records append-only where history matters. ids opaque. every record
carries created_at/updated_at.

### Case
| field | notes |
|---|---|
| id | |
| account_family | buyer \| creator |
| account_ref | bin or cin, one or the other, never both |
| market | iso 3166-1 alpha-2 |
| language | bcp-47 |
| source_channel | web_form \| in_app \| email |
| subject, body | raw intake text |
| intent_tag_raw | free text as captured |
| intent_tag | mapped into the fixed taxonomy, else `other` |
| gate_verdicts | themailtell / thephonetell / thelocaletell outcomes, when applicable |
| state | open \| deflected \| ticketed \| rate_limited \| merged |

cases have their own append-only event log (see §6) so deflection
attempts are inspectable even when no ticket exists.

### Ticket
| field | notes |
|---|---|
| id | |
| case_ref | the case that produced it |
| queue | buyer \| buyer_to_be \| creator_support \| creator_question |
| priority | age-based score, recomputed on read |
| order_refs | 0..n; multi-store checkout means one contact can span n orders |
| order_segments | per-order snapshot: segment id, shop sin, items, value, escrow state |
| escrow_snapshot | captured at ticket creation, not live |
| payout_snapshot | creator queues only: next payout date (the 15th), pending amounts |
| deflection_summary | what was offered, what was tried, link to case events |
| assigned_agent | current, or null |
| state | see §5 |
| reopened_from | ref to ancestor ticket when this is a reopen |
| merged_into | ref when superseded |

snapshots are deliberately frozen: support reasons about what was true
at contact time; live order state is re-fetched on demand in the
workspace, clearly labeled as current.

### TicketEvent
append-only, no updates, no deletes, agents cannot remove rows.

| field | notes |
|---|---|
| ticket_ref, seq | per-ticket monotonic |
| type | enum, §6 |
| actor | system \| agent id \| account (bin/cin) |
| payload | json, type-specific |

### AgentProfile
| field | notes |
|---|---|
| id | |
| handles | list of (queue, market, language) sets |
| concurrency_cap | per-agent, default from QueueConfig |
| senior | eligibility for senior queues |

### QueueConfig (one row per queue)
defaults for: per-agent concurrency cap, burst multiplier, spike windows
(e.g. the 15th for creator queues, drop windows for buyer queues), per-
account per-day rate limit, duplicate merge window, first-response target.

### ResponseLibraryEntry
canned answers. each entry **must** reference doc/kb/academy entries by
link; no free-text knowledge lives only here. validated on save.

### config (single versioned object)
intent tag taxonomy, money-adjacent tag set, priority curve, reopen
window (14 days), rate limits, merge windows, burst multipliers, spike
windows. changing any of it is a config change, not a code change — but
new intent tags require a recorded queue-mapping decision, since
assignment is a function of them.

## 3. intent tag taxonomy (initial, config-owned)

buyer:
- `where_is_it`, `refund_request`, `quality_issue`, `manufacturer_delay`
  (post-purchase; expect an order attached)
- `checkout_failure`, `payment_declined`, `address_rejected`,
  `listing_question` (pre-purchase)
- `account_access`, `other`

creator:
- `payout_issue`, `listing_release_problem`, `order_fulfillment`,
  `refund_dispute` (money-adjacent)
- `idv_pending`, `idv_rejected` (identity verification: idv gates
  payouts, so idv issues sit beside payout issues in creator_support
  but keep their own subject — a "payout failed" ticket that is
  really an idv hold becomes measurable instead of confounded)
- `how_to`, `clarification`
- `account_access`, `other`

buyer:
- `where_is_it`, `refund_request`, `quality_issue`, `manufacturer_delay`
  (post-purchase; expect an order attached)
- `checkout_failure`, `payment_declined`, `address_rejected`,
  `listing_question` (pre-purchase)
- `account_access`, `other`

free intake maps to exactly one tag; unmappable goes to `other` and
triage re-tags. re-taging emits an event (input to misrate accounting).

### 3.0 two axes: kind (both families) and subject (issues)

owner ruling 2026-10-16: creators and buyers can both have questions
or issues. kind is a family-orthogonal axis logged at intake for
every contact; subject records what an issue is with respect to.

- **kind**: `question` | `issue` (plus the non-ticket kinds of §3.1).
  both families carry both kinds — the creator family realizes the
  split at queue level (creator_support vs creator_question); buyers
  realize it as a logged axis (routing stays attachment-based by
  design) that drives SLA targets and workspace treatment:
  questions get question-target response times and no
  order/escrow/payout panels, issues get the issue-target SLA.
- **subject** (issues only): creator subjects — `payout`, `idv`,
  `listing_release`, `fulfillment`, `account`, `other`; buyer
  subjects — `order`, `checkout`, `account`, `other`. subject is
  derived from the intent tag at assignment, recorded on the
  assignment event, and never changes routing on its own: it is a
  measurement and workspace axis, so the payout/idv confound and
  the subject mix per queue become visible without touching the
  pure function.

### 3.1 contact kinds (the fork before the queues)

owner ruling 2026-10-16: a creator account issue is its own thing,
different from a bug report, different from a vulnerability
disclosure, different from a feature request — and all of them are
different from support demand. kind is classified at intake
(`kind_declared` event, raw text preserved), correctable by logged
event and measured like queue misroutes. the fork runs before queue
assignment: only two kinds ever produce tickets.

1. `support_issue` — in scope, the four queues. account issues are
   issues, not questions: `account_access` / account status tags
   route to the issue queues (buyer by order attachment; creator to
   creator_support — see §4 note). account-blocking counts like
   money-adjacent for routing: something must be done, not
   answered.
2. `question` — the query queues (buyer-to-be questions,
   creator_question). how-to and clarification stay out of the issue
   queues; a question queue is not an issue queue in either
   direction.
3. `bug_report` — a product defect, not support demand. receipt
   record + status view (received → triaged → filed | duplicate),
   routed to the engineering tracker as a signal: support never
   claims a fix, a timeline, or a verdict on the defect. duplicate
   merge against open reports. an agent who spots a defect mid-ticket
   files the same receipt from the ticket, linked, and the ticket
   proceeds independently.
4. `vulnerability_disclosure` — the sensitive lane, under the
   security disclosure policy (separate doc). dedicated channel
   (config); anything arriving on a normal channel that classifies
   as a disclosure is re-routed with a templated ack, and the
   record never enters shared queue views or public measurement
   beyond counts. access-restricted from receipt; no case, no
   ticket, no cross-link to the reporter's other records.
5. `feature_request` — product feedback. receipt + signal to the
   product backlog, no human queue burn; duplicates merge into a
   demand counter the product system owns. acks never imply
   roadmap promises.

not everything is a ticket, made literal: kinds 3-5 get receipt
records with a small lifecycle (new → acknowledged → routed →
closed), retention consent, a status view, and a port to their
owning system (engineering tracker, security response, product
backlog) — the case/ticket machinery never sees them, and no
receipt kind fires any queue, routing, or priority behavior.
receipt records are append-only events like everything else.
gates (email eligibility, rate limits) run identically for all
kinds; kind never softens or hardens a gate.

## 4. queue assignment (the pure function)

```
assign(family, order_attached, intent_tag):

  if family == buyer:
      return order_attached ? BUYER : BUYER_TO_BE

  # creator
  if order_attached
     or payout_context_present
     or intent_tag in money_adjacent_set
     or intent_tag in account_issue_set:
      return CREATOR_SUPPORT
  return CREATOR_QUESTION
```

owner ruling 2026-10-16: creator account issues (access, status,
verification) are issues, not questions — `account_issue_set` widens
creator_support to account-blocking matters even with no order or
payout context attached. buyer account issues stay pure: they route
by order attachment (buyer if purchased, buyer-to-be if the issue
blocks them from purchasing).

notes:
- `order_attached` is a property of the contact, not the account: a buyer
  asking about a failed new checkout carries no order ref and lands in
  buyer-to-be even though they have past orders. this is what keeps the
  function pure.
- `payout_context_present` is a boolean captured at intake (contact
  mentions a payout/shop money matter), stored, logged. it is an input,
  not a lookup the function performs.
- the assignment event on the ticket records all inputs plus
  the output: (family, order_attached, kind, intent_tag) → queue,
  with the derived subject. any later queue change (triage
  correction, escalation) is its own event, so misroute rate per
  intent tag is measurable.
- kind never changes buyer routing (attachment stays the only buyer
  split); kind changes creator routing only through the
  question/issue queue pair that already exists. buyer questions
  surface kind to SLA config and the workspace, never to a queue.

## 5. state machine

```
new → triaged → in_progress → waiting_on_user → resolved → closed
                     ↑             │
                     └─────────────┘
```

- `waiting_on_user` tickets auto-nudge (config) and never auto-resolve.
- reopen within 14 days of close: creates a **linked new ticket**
  (`reopened_from`), inherits the ancestor's event history by
  reference (workspace renders the chain read-only; new events append on
  the new ticket). after 14 days it is a fresh contact.
- duplicate merge: same account + same intent tag within the config
  window (default 48h) merges into the open ticket. the new case is
  marked `merged`, its content appends to the open ticket as a
  `merged_contact` event. nothing is deleted; both cases remain
  queryable.
- escalation: move to the senior counterpart queue on the same event
  chain. one `escalated` event, `ticket.queue` changes, chain preserved.

## 6. event types

case events: `case_created`, `gate_verdict`, `intent_tagged`,
`lookup_result`, `deflection_offered`, `deflection_accepted`,
`human_requested`, `rate_limited`.

ticket events: `ticket_created` (carries assignment inputs),
`queue_assigned`, `agent_assigned`, `state_changed`, `note_added`,
`response_sent`, `merged_contact`, `escalated`, `proposal_created`,
`proposal_result`, `reopened`, `closed`.

every state change, note, deflection, response, and assignment is an
event. no silent edits, no event mutation, no agent deletes.

## 7. flows

### 7.1 intake (all channels)
1. contact arrives → case row + `case_created` immediately. email runs
   the themailtell eligibility gate **before** the case is admitted; a
   failed gate is an intake rejection with the reason surfaced, no case.
2. normalizer resolves family + bin/cin, market, language, contact
   kind, intent tag (`intent_kind_declared`, `intent_tagged` events,
   raw text preserved). kinds other than support_issue/question get
   their receipt record and leave the case path here (§3.1);
   vulnerability disclosures never enter it at all.
3. gates run per contact shape: phone line-type verification state
   (thephonetell) and address-shape verdict (thelocaletell; the po-box
   ban lives there) attach as `gate_verdict` context, never as blockers
   here.
4. rate limit check (per account per queue per day, config). trips are
   logged (`rate_limited`); the contact still merges into any open
   ticket so nothing is lost, and surfaces as a chip for triage.
5. retelldb lookup with case text, market, language
   (`lookup_result`).
6. deflection screen: suggestions + deep links (`deflection_offered`).
7. resolved → `deflection_accepted`, case closed. or one explicit
   "still need a human" → `human_requested`, ticket created.

### 7.2 ticket + routing
1. ticket created; `ticket_created` event carries (family,
   order_attached, intent_tag) → queue output. snapshots captured:
   order segments + escrow state, payout schedule for creator queues.
2. routing key (queue, market, language) → eligible agents →
   round-robin among those under their concurrency caps. burst mode
   (multiplier × cap, on during configured spike windows) widens
   capacity only; priority rules never change.
3. priority is age-based only (configurable curve over minutes open).
   order value renders as context. trust, spend history, fraud and vpn
   flags render as context chips, never ranking inputs.

### 7.3 agent working a ticket
1. triage: verify queue (re-tag/re-queue if needed, both as events),
   state → `triaged`.
2. `in_progress`: identity panel (bin/cin, verification badges, market +
   language, context chips), order segments with escrow state, payout
   schedule (creator support only), full deflection history, retelldb
   drafts. drafts are drafts: the agent owns what gets sent.
3. responses come from the response library (link-validated entries)
   or free text; sent → `response_sent`, state → `waiting_on_user`.
4. resolution: `resolved` → `closed`. close is a human action, never
   automatic.

### 7.4 money proposals (the only money path)
1. agent proposes refund (order refs, amount, reason) or payout
   investigation → `proposal_created` event, proposal sent to the
   payments system via the bridge.
2. payments system executes (or rejects) and posts the result back →
   `proposal_result` event. the workspace has no money-moving controls;
   refunds stay per-order, never cart-wide, because proposals carry
   order refs by construction.

### 7.5 abuse reports
filed from a ticket → forwarded to the moderation layer as a **signal**,
never a verdict. support never enforces; the report event links the
moderation ref for later joining.

## 8. measurement (from events only)

- deflection rate per intake point, per intent tag, per market.
- ticket volume per queue; first human response time vs per-queue
  target; time to resolve; reopen rate (14-day window).
- misroute rate: queue re-assignment events / total tickets, by intent
  tag. the assignment log makes this exact.
- contact-kind share and kind-correction rate (is the fork legible?);
  question vs issue share per queue (both families); subject mix per
  issue queue; the payout/idv confound rate (payout-subject tickets
  re-tagged to idv and back). bug reports filed vs. received;
  disclosure ack time; feature-request duplicate demand. all from
  kind + assignment events only.
- duplicate merge rate, rate-limit trips per account (abuse signal to
  moderation if patterned), burst-window latency vs normal.

## 9. build phases

1. **core.** case + ticket + event schemas, state machine, queue
   assignment function (unit-tested against the taxonomy), append-only
   enforcement.
2. **intake + deflection.** channel adapters, gates behind interfaces,
   the contact-kind fork (§3.1: receipt records + routing signals for
   bug reports, disclosures, feature requests), retelldb lookup +
   deflection screen, offer logging. straight-to-
   ticket mode until deflection content exists.
3. **routing + workspace.** agent profiles, round-robin, caps,
   priority, workspace panels, response library with link validation.
4. **proposals + lifecycle.** proposal bridge, escalation, reopen
   linking, duplicate merge, abuse signal.
5. **burst + measurement.** spike windows, burst multipliers, the
   measurement job, per-queue tuning against real volume.

each phase ends with the previous behavior intact: the system is the
human tail, so phase 1 alone already prevents nothing from being lost.
