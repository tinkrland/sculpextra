# support



these ticket queues w human response lookup can be divided into a different few branches

and not everything is a ticket: intake forks on contact kind before
the queues — support issue, question, bug report (receipt + signal to
the engineering tracker), vulnerability disclosure (the sensitive lane,
own channel, access-restricted), feature request (receipt + signal to
the product backlog). only issues and questions ever become tickets.
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
- `ticketing/` — phases 1-4: event-sourced core, intake with the
  deflection pipeline (retelldb lookup, deflection screen, one-click
  human handoff), routing (round-robin over agent routing sets with
  per-agent concurrency caps, age-only priority curve), the agent
  workspace view (identity/order/payout/deflection panels, retelldb
  drafts), the link-validated response library, and the proposal
  bridge (per-order refund proposals and payout investigations to the
  payments system, results posted back as ticket events) plus abuse
  signals to moderation (signals, never verdicts)
  (see `specs/architecture.md` §9)
