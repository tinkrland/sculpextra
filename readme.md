# support



these ticket queues w human response lookup can be divided into a different few branches
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
- `ticketing/` — phases 1 + 2: event-sourced core, intake with the
  deflection pipeline (retelldb lookup, deflection screen, one-click
  human handoff; see `specs/architecture.md` §9)
