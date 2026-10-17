# support



these ticket queues w human response lookup can be divided into a different few branches

and not everything is a ticket: intake forks on contact kind before
the queues — support issue, question, bug report (receipt + signal to
the engineering tracker), vulnerability disclosure (the sensitive lane,
own channel, access-restricted), feature request (receipt + signal to
the product backlog). only issues and questions ever become tickets.
kind is family-orthogonal (creators and buyers both have questions and
issues), and issues carry a subject — what they are wrt: creators
payouts, idv, listing/release, fulfillment, account; buyers order,
checkout, account.
- buyer queue (has already purchased)
- buyer-to-be queue (facing issues placing an order)
- creator queue (support) vs creator queue (question)

and some other things that will exist that happen first, not everything is a ticket.
- onboarding packet + platform how-tos
- docs (creators side)
- knowledgebase
- sculptura academy (basically how-to's / learning specific stuff form of written + image content)
- retelldb (trained on all of the above + customer side too)

## docs

- `specs/build-spec.md` — the ticketing queue build spec (verbatim)
- `specs/architecture.md` — system architecture, flows, process, build phases
- `specs/dispute-build-spec.md` — the outside-artist art-theft
  dispute build spec (verbatim)
- `specs/dispute-architecture.md` — dispute architecture, flows,
  process, build phases; companion system to ticketing (external
  claims only; platform-artist theft stays paracraft-side; the
  public entry forks question vs claim — a question is not a claim)
- `dispute/` — the outside-artist art-theft dispute system
  (spec: `specs/dispute-build-spec.md`, `specs/dispute-architecture.md`):
  event-sourced claims with the question fork at entry, the
  completeness gate (bounce exactly once), on-demand evidence
  artifacts (signals never verdicts), provisional measures from the
  stashed provisional_default config slot, the statute-versioned
  dmca counter-notice loop, signed decision records as the only
  enforcement mover, the policy-gated bad-faith registry, counsel
  clock pauses, and the measurement job from events only. all 12
  acceptance criteria tested; 21/21 green. the delist vs
  notify-only ruling remains stashed (§14.1): both postures are
  built and tested; the shipped default is notify_only until the
  owner rules.
- `ticketing/` — phases 1-5 complete, plus the contact-kind fork:
  bug reports, vulnerability disclosures, and feature requests are
  receipt records with routing signals (never tickets); kind and
  subject are logged axes on every contact; burst mode widens
  concurrency caps during config-owned spike windows (priority never
  changes); the measurement job aggregates every metric from the
  event logs only (see `specs/architecture.md` §3, §7.2, §8)
 event-sourced core, intake with the
  deflection pipeline (retelldb lookup, deflection screen, one-click
  human handoff), routing (round-robin over agent routing sets with
  per-agent concurrency caps, age-only priority curve), the agent
  workspace view (identity/order/payout/deflection panels, retelldb
  drafts), the link-validated response library, and the proposal
  bridge (per-order refund proposals and payout investigations to the
  payments system, results posted back as ticket events) plus abuse
  signals to moderation (signals, never verdicts)
  (see `specs/architecture.md` §9)
