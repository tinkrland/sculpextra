# outside-artist art-theft dispute handling: build spec

(verbatim owner spec, 2026-10-16. the architecture extends this in
`dispute-architecture.md`.)

companion to the ticketing queue spec. same disciplines:
deflection-style intake gating, queues, append-only records,
signals never verdicts, human-gated enforcement.

platform-artist (creator vs creator) theft is NOT handled here: it
is covered paracraft-side, where deterministic geometry, release-time
similarity comparison, template provenance, and release gating
settle it mechanically. this spec only covers claims from OUTSIDE
the platform: artists with no sculptura account claiming a listed
design steals their work.

## what this system consumes (exists, not rebuilt)

- paracraft release pipeline: deterministic geometry, versioned
  releases with timestamps, release-id metadata in exported files,
  per-order unique watermarks
- paracraft similarity machinery (the same comparison that gates
  releases), run on demand between a claimed original and a listed
  release, attached to the claim as a report
- template provenance lookup: if the accused design derives from a
  house template, neither party owns the base
- chain of title: license records; the commercial grant is the
  provable-ownership path
- naming discipline (ip-licensing.md): "license violation" vs
  "ip infringement" are different claim types; intake carries the
  distinction so reviewers do not misroute

## intake (public, no account required)

a claim form anyone can file, requiring all of:

- claimant identification and contact
- identification of the claimed original work (links, images,
  registration if any)
- the specific sculptura listing(s) claimed (urls or ids)
- a statement of the claimant's rights in the work
- a good-faith attestation (dmca-style elements)
- acceptance that the claim record is retained in-platform

incomplete claims bounce exactly once with what is missing; a
complete claim is never gated behind account creation, never a
maze.

## triage and review

- claimant identity is unverified by definition: every claim is an
  allegation, never a verdict. signals never verdicts, applied to
  accusers too.
- reviewer evidence view: listing release history vs claim timeline
  (timestamps prove publication order, not authorship; the report
  says so), on-demand similarity report, chain-of-title lookup,
  template provenance of the accused design.
- template-provenance shortcut: accused design derives from a house
  template -> neither the claimant nor the creator owns the base;
  many claims resolve here with an explanation, no takedown.

## provisional measures and outcomes

- facially complete claim naming a listing: provisional delist
  (from search and storefront; reversible; logged; creator notified
  with the claim summary) pending review. ruling needed: delist
  default vs notify-only default.
- outcomes: reject (listing restored, decision logged), uphold
  (delist stands, enforcement-ladder event), escalate to counsel
  (substantiated claims on contested-territory ip).
- dmca statutory mechanics where they apply (counter-notice,
  restore windows): implement the workflow sized to current statute;
  counsel confirms the posture. not legal advice; enforcement
  posture finalizes only after counsel review (standing rule from
  ip-licensing.md).
- abuse controls: per-claimant rate limits, duplicate merge, and a
  bad-faith claimant registry that is policy-gated, never automatic.

## enforcement ladder (separate policy doc, human-gated)

dispute outcomes feed a deliberate repeat-infringer ladder as
evidence events: first upheld claim (warning), repeat (delist +
review), serial (account action). a human signs each step. no
automatic trust, fee, or ranking consequences ever fire from a
dispute state (fee-logic invariance extended to disputes).

## invariants

1. every claim, response, evidence artifact, decision, and state
   change is an append-only event; nothing unwritten, never deleted.
2. claims and similarity scores are signals; only a signed human
   decision event moves enforcement.
3. no fee/trust/ranking consequences except through the signed
   enforcement ladder.
4. outside claimants see claim status and outcomes only; never
   internal ids, creator personal data, or financial data.
5. provisional delists are reversible and their restoration is
   logged as loudly as their application.
6. counsel review precedes any final enforcement posture on
   generated-geometry claims.

## state machine

new -> completeness_check -> (bounced | under_review) ->
provisional_action_logged -> decided -> (rejected_restored |
upheld_delisted | escalated_counsel) -> closed. reopen within 30
days links to history; counsel escalation pauses the clock.

## measurement

- claims per 1000 listings per month
- substantiation rate (upheld / total)
- time from complete claim to decision; false-positive delists
  restored
- reviewer hours per claim (feeds the support-cost export like
  every other human-touch line)

## acceptance criteria

1. incomplete claim bounces exactly once with the specific missing
   elements; a complete claim never requires an account.
2. template-provenance claims resolve with the provenance
   explanation attached.
3. every enforcement action traces to a signed human decision event
   in the append-only record.
4. provisional delist and its restoration are both first-class
   logged events.
5. no dispute state ever changes a fee, trust, or ranking value
   directly (test explicitly).
6. outside claimants see status only; no creator personal data
   exposure (test explicitly).
7. daily export produces claim volume, substantiation rate,
   time-to-decision, reviewer hours.

(owner instruction for the architecture doc: "make more branches" —
the expansion below carries the additional subsystem branches.)
