# outside-artist art-theft dispute handling: architecture + flow + process

extends the dispute build spec (`specs/dispute-build-spec.md`).
implementation-neutral: the event-sourced core is storage-portable,
every external dependency sits behind an interface. same disciplines
as the ticketing system (`specs/architecture.md`): deflection-style
intake gating, queues, append-only records, signals never verdicts,
human-gated enforcement.

terminology is fixed: markets and territories as **iso 3166-1
alpha-2**; internal ids opaque; the filing party is an **outside
claimant** (no bin, no cin, no account, by design); the accused
listing's creator is the **responding creator**. claim types carry
the ip-licensing.md naming discipline: **ip infringement**
(authorship contested) and **license violation** (use beyond a
grant) are different claim types and are never conflated in records
or reviewer routing.

## 1. scope and relationships

this system handles claims from OUTSIDE the platform only: artists
with no sculptura account claiming a listed design steals their
work. it is deliberately NOT:

- **a fifth ticketing queue.** the ticketing taxonomy assigns by
  (account family, order attachment, intent tag) — none exist for
  an external claimant. the queue discipline is mirrored (routing,
  caps, priority) on a parallel record type, not shared. reviewer
  hours still feed the same support-cost export.
- **the platform-artist dispute path.** creator-vs-creator theft
  is settled paracraft-side by machinery (deterministic geometry,
  release-time similarity comparison, template provenance, release
  gating) that runs mechanically at release time. this system
  consumes the same similarity machinery on demand as evidence.
- **an enforcement engine.** delists happen here (provisional,
  reversible, or decided), but repeat-infringer consequences fire
  only from the signed enforcement ladder (§11), never from a
  dispute state directly.
- **blind to question traffic.** some people arriving at the claim
  form just have a question (how licensing works, what provenance
  means, whether they should file at all). a question is not a
  claim, the same way the ticketing spec keeps buyer-to-be
  questions out of the buyer issue queue: questions get the
  inquiry path (§5.1), never a claim record.
- **legal counsel.** the dmca-shaped workflow is statute-sized and
  parameterized; counsel confirms posture on every escalated claim.
  no output of this system is legal advice.

## 2. system architecture

```
 public web ──┐            ┌────────────────────────────────────┐
 (no login)  │            │  entry fork: question or claim?      │
             └───────────►└──────┬───────────────────┬──────────┘
                             question │           claim │
                     ┌───────────────▼──┐   ┌────────▼─────────────────────┐
                     │ inquiry path      │   │  intake service               │
                     │ public content    │   │  educational screen →         │
                     │ deflection, one   │   │  completeness gate → bounce-  │
                     │ public-questions  │   │  once or claim record         │
                     │ queue for the rest│   └───────────────┬────────────────┘
                     └───────────────────┘                   │
                                          │ claim (append-only events)
                          ┌───────────────▼────────────────────┐
                          │  evidence assembly (on demand)       │
                          │  similarity report (paracraft) │     │
                          │  release history timeline │ provenance │
                          │  chain-of-title lookup │ watermarks  │
                          └───────────────┬────────────────────┘
                          ┌───────────────▼────────────────────┐
                          │  review queue (routing, caps,        │
                          │  age-only priority) │ reviewer view   │
                          └───────┬──────────────────────┬───────┘
                          proof shortcut             full review
                          (template │                 │
                          provenance)│                 │
                          ┌─────────▼──────────────────▼───────┐
                          │  provisional measures (marketplace │
                          │  port: delist/restore, notify)     │
                          └───────────────┬────────────────────┘
                                          │ decided (signed human)
                          ┌───────────────▼────────────────────┐
                          │  outcomes: restore │ uphold │ counsel│
                          │  dmca loop: counter-notice, window,  │
                          │  restore-or-refile                  │
                          └───────────────┬────────────────────┘
                                          │ evidence events only
                          ┌───────────────▼────────────────────┐
                          │  enforcement ladder (separate policy │
                          │  doc, human-signed steps) │ registry │
                          └───────────────┬────────────────────┘
                                          │
                          ┌───────────────▼────────────────────┐
                          │  measurement job (from events only)  │
                          │  → support-cost export, dashboards   │
                          └──────────────────────────────────────┘

consumed interfaces (all behind adapters): paracraft similarity
report, paracraft release history, template provenance, chain of
title, marketplace delist/restore, notification (claimant +
creator), counsel queue. produced signals: enforcement ladder
events, support-cost lines, abuse signals to moderation.
```

## 3. claim type taxonomy (initial, config-owned)

the taxonomy is config, not code: changing it is a config change.
every claim carries exactly one primary type at intake; the reviewer
may add secondary types with a logged correction event.

1. **ip_infringement**: the claimant alleges the listed design
   copies their original work (authorship contested). the
   similarity report and timeline are primary evidence.
2. **license_violation**: the claimant alleges use beyond a grant
   they hold (e.g. a license limited to personal use). chain of
   title is primary evidence; similarity is secondary.
3. **trademark_or_publicity**: marks or likeness rather than design
   authorship. routed for counsel triage early; similarity reports
   are not authoritative here.
4. **other_ip**: everything else. routed to counsel triage.

misrouting between ip_infringement and license_violation is
measured like ticketing misroutes: type correction events / total
claims, by intake type.

## 4. data model

all records append-only where history matters. ids opaque. every
record carries created_at/updated_at.

### Claim (one per filed claim)
- id, claim_type, submitted_at, locale, market (claimant-declared,
  iso 3166-1 alpha-2, informational only)
- claimant block: name, contact (email or post channel), statement
  of rights, good-faith attestation elements (perjury-acknowledged,
  authorized-to-act, good-faith-belief), retention consent
- claimed original refs: urls, image uploads, registration numbers
  if any
- items: the specific listings claimed (see ClaimItem)
- state (§15), reviewer refs, evidence refs, decision refs

### ClaimItem (one per accused listing)
- claim_ref, listing_ref, listing release history snapshot ref
- provisional measure (none | delisted | notify_only) + measure ref
- item outcome (pending | rejected | upheld | escalated), outcome
  decision ref
- a claim closes when every item is decided (a single claim naming
  three listings can reject two and uphold one: per-item outcomes,
  one signed decision event per item)

### EvidenceArtifact (immutable once attached)
- id, claim_ref, kind: similarity_report | release_history |
  provenance_lookup | chain_of_title | watermark_trace | claimant_upload
- payload_ref (content-addressed storage), produced_by (port id +
  engine/record version), attached_at
- similarity reports carry their score and banding as **signal
  data**; the report text itself states: timestamps prove
  publication order, not authorship

### DecisionRecord
- id, claim or item ref, outcome, reasoning summary, reviewer id,
  **signature** (human), decided_at
- only this record type moves enforcement (invariant 2/3)

### ProvisionalMeasure
- id, item ref, action (delist | notify_only), applied_at,
  restored_at (when reversed), marketplace port refs both ways

### CounterNotice
- id, item ref, creator statement, statutory timer ref, filed_at

### RegistryEntry (bad-faith claimant)
- claimant contact hash, policy citation, human signature, added_at
- policy-gated, never automatic (§12)

### ReviewerHours
- reviewer id, claim ref, date, hours — the support-cost export input

### Inquiry (question path only, never a claim)
- id, contact (optional), question text, locale, search refs used
- state (new → answered → closed), answer refs (content links or a
  human reply), closed_at
- retained under the same consent rules as claims; aggregate search
  terms feed measurement, never claimant registries

## 5. intake branch

the public entry is a fork, not a form (§5.1). past the fork,
deflection discipline applies to accusers:

- **educational screen before the form** (the deflection analog):
  the claim form opens with the naming discipline (infringement vs
  license violation, plain-language), and the template-provenance
  disclosure (if the design derives from a house template, neither
  party owns the base — many claims resolve by knowing this before
  filing). a claim never filed is the cheapest resolution. the
  screen links out to the public provenance explanation and never
  hides the form behind it: one scroll, no maze.
- **completeness gate**: all required elements (§ intake list) or
  bounce. the bounce lists the specific missing elements, exactly
  once. a bounced claim record is terminal; resubmission creates a
  new claim linked to it (for abuse measurement, never for
  punishing the claimant).
- **account-free forever**: no sculptura account is ever required
  to file, track, or receive an outcome. claim status is reachable
  by the claimant-provided contact channel + opaque claim id.
- **contact validation gate** behind an interface (same discipline
  as themailtell in ticketing): email reachability only, verdicts
  as chips, never a routing input. an unreachable contact channel
  is a bounce reason (the claimant could not be notified), not a
  rejection of the claim's merits.
### 5.1 question fork (a question is not a claim)

mirroring the ticketing discipline that a question queue is not an
issue queue (buyer-to-be vs buyer; creator question vs creator
support), the claim entry opens with the fork before any form field:

- **inquiry path**: the asker searches the same public content the
  platform already maintains (kb, docs, academy, the provenance
  explanation — the deflection machinery, not a rebuilt one; the
  response library's link-validation discipline applies to every
  canned answer). contact is optional until a human reply is
  needed. no account is ever required here either.
- **unresolved questions**: one public-questions queue, answered by
  a human through the contact channel the asker provided, closed as
  answered. there is exactly one such queue and it never produces
  claim records, provisional measures, or registry entries.
- **question that is really a claim**: the answer hands the asker
  the claim form; nothing auto-files.
- **claim that is really a question**: the reviewer reclassifies
  with a logged event — the item closes as `closed_referred` with
  the referral link attached. a reclassification is not a merits
  decision: it never counts in the substantiation rate and never
  fires enforcement events.
- the inquiry path borrows the ticketing deflection machinery
  (retelldb lookup over public content, one-click escalation to the
  human queue) rather than inventing a second deflector.

- **rate limits**: per-claimant-contact per day, config-driven;
  trips log an event and are visible to reviewers. registry entries
  tighten limits per policy (§12), never block filing outright.
- **duplicate merge**: same claimant contact + same listing within
  the config window merges into the open claim as an amendment
  event, never a second review.

## 6. evidence assembly branch

evidence is produced on demand, attached as immutable artifacts,
and always labeled signal-not-verdict:

- **similarity report** (paracraft port): the same machinery that
  gates releases, run between the claimed original and the listed
  release. score bands are advisory. the report template states
  what geometry comparison can and cannot prove.
- **release history timeline** (paracraft port): deterministic
  release timestamps vs the claimed original's publication
  timestamps, side by side. the report states: timestamps prove
  publication order, not authorship.
- **template provenance lookup**: if the accused design derives
  from a house template, neither party owns the base. this is the
  **proof shortcut**: reviewer resolves with an explanation and
  no takedown; the provenance explanation attaches to the decision.
- **chain of title** (license records port): the commercial grant
  is the provable-ownership path. a claimant holding a grant that
  covers the listed use changes the review entirely.
- **watermark trace**: per-order unique watermarks tie exported
  files to orders. when a claimed original is itself an exported
  file (leak case), the trace identifies the source order — a
  counsel-grade lead, attached as an artifact.

evidence requests are logged events; costs of on-demand runs are
configurable per port and feed the measurement job.

## 7. review branch

- routing mirrors ticketing discipline, on claim records: review
  sets keyed by (claim_type, market, language), round-robin with
  per-reviewer caps, age-only priority. counsel-triage claims
  (trademark_or_publicity, other_ip) route to the counsel-facing
  set.
- the reviewer view shows: claimant block + attestation elements,
  claimed original refs, item cards (per listing: release history,
  provisional state, evidence refs), the full event history, and
  the decision composer. it shows no fee, trust, or ranking values
  of the responding creator (invariant 4/6).
- reviewer hours are logged per claim per day (support-cost export
  line, like every other human-touch).
- every evidence artifact is visible to the reviewer before any
  decision event is signable (decision composer gates on evidence
  review, not on score thresholds).

## 8. provisional measures branch

- a facially complete claim naming a listing triggers the
  configured **provisional default**: `delist` (search + storefront,
  reversible, logged, creator notified with the claim summary) or
  `notify_only` (creator notified, listing stays up pending
  review). **owner ruling needed** (see §14.1): the default is
  config, either posture is buildable, and the ruling is recorded as
  a config decision with its rationale.
- delist and restore are first-class events with marketplace port
  refs both directions; restoration is logged as loudly as
  application (invariant 5).
- provisional measures carry no enforcement meaning: a restored
  provisional delist leaves no mark; the enforcement ladder counts
  only upheld decisions (§11).
- claims against already-delisted listings need no provisional
  measure; review proceeds normally.

## 9. dmca statutory branch

sized to statute at build time, parameterized because statutes move:

- on a facially complete claim under the delist default, the
  statutory window to counter-notice is exposed to the responding
  creator (duration from config, statute-versioned; counsel confirms
  posture per standing rule).
- **counter-notice** filed → statutory restore timer starts → on
  expiry with no refile from the claimant, the listing restores
  (logged as restore_after_counter_notice).
- claimant refile within the window moves the item to counsel; the
  clock pauses (§15) and no further mechanical action fires.
- every timer transition is an event; timers are caller-owned (same
  rule as ticketing routing: the core exposes the state machine,
  the host runs the clock).

## 10. decisions and outcomes branch

outcomes are per item, each a signed DecisionRecord:

- **rejected**: listing restores (if provisionally delisted), the
  rejection reasoning is logged, the claimant sees "reviewed, not
  upheld".
- **upheld**: delist stands, an enforcement-ladder evidence event
  fires (§11), the responding creator is notified with the decision
  and their counter paths.
- **escalated_counsel**: substantiated claims on contested-territory
  ip. the claim pauses (clock stop), counsel owns posture; nothing
  mechanical fires while paused.
- **withdrawn**: the claimant may withdraw any item or the whole
  claim at any time; withdrawal is logged, never treated as
  bad-faith evidence by itself.
- **referred (reclassification)**: a claim that is actually a
  question closes as closed_referred with the answer link attached;
  no merits decision, no substantiation-rate entry, no enforcement
  event. reclassification is logged with the reviewer's signature
  like every state change.
- **reopen**: within 30 days, a reopened claim links to its history
  (same chain discipline as ticketing); after that, new evidence
  files a new claim linked to the old.

## 11. enforcement ladder branch (separate policy doc)

dispute outcomes feed the repeat-infringer ladder as evidence
events only:

1. first upheld claim → warning
2. repeat → delist + review
3. serial → account action

each step is signed by a human against a cited policy paragraph.
no automatic trust, fee, or ranking consequences ever fire from a
dispute state (fee-logic invariance extended to disputes): the
ladder is the only bridge, and it is human-gated at every step.
ladder state is owned by the ladder doc + its own record type; the
dispute system only emits `enforcement_step_signed` evidence
events.

## 12. bad-faith registry branch

- entry criteria live in the policy doc (patterns: serial filings
  against competing shops, forged registrations, perjury-adjacent
  attestations). entries are added by signed human action citing
  policy, never automatically from claim states.
- registry effects: tightened per-day rate limits (config), a
  reviewer-facing chip on later claims. registry entries never
  block filing outright (a registry claim can still be substantiated)
  and never touch fees, trust, or ranking.
- contest path: a registry entry can be reviewed and removed by a
  signed human action; removal is a first-class logged event.
- registry entries hash contact identifiers, never store raw
  personal data beyond what the claim record already holds.

## 13. privacy and exposure branch

- the claimant sees claim status and outcomes only, through their
  contact channel or an opaque-status link: never internal ids,
  creator personal data, creator financial data, similarity scores,
  or other claims.
- the responding creator sees the claim summary (what is claimed,
  which listing, the provisional measure, their counter paths),
  never the claimant's contact details or registration documents
  before counsel stage — only what the policy doc designates as
  the notification package.
- export views are scrubbed projections of events: no raw uploads
  leave the platform; measurement uses counts and durations only.
- claimant uploads live in isolated storage with per-artifact
  retention rules from the policy doc; nothing is deleted silently
  (invariant 1) — retention expiry is a logged event.

## 14. config (data, not code)

like ticketing: one frozen config object; every rule below is a
value, never a code path.

### 14.1 owner-ruling slot: provisional default
- `provisional_default: "delist" | "notify_only"` — pending owner
  ruling. delist default matches dmca-safe-harbor posture on
  facially complete claims; notify-only default reduces
  false-positive harm to responding creators at the cost of
  exposure. the ruling, its date, and rationale are recorded with
  the config commit.
- implementation status (2026-10-16, stashed per owner
  instruction): both postures are built and fully tested; the
  shipped default is `notify_only` until the ruling lands, and a
  human can still apply a provisional delist manually
  (signature-gated). flipping the default is a one-line config
  change.

### 14.2 queue + limits
- per-reviewer caps, review set assignments, rate limits per
  claimant per day, duplicate merge window, reopen window (30d),
  counsel clock-pause rules, similarity-run cost caps, restore
  window + counter-notice duration (statute-versioned), retention
  durations.

## 15. state machine (claim level, with item overlay)

```
new → completeness_check → bounced                (terminal; resubmission links)
                         → under_review
under_review → provisional_action_logged → decided → rejected_restored → closed
                                               → upheld_delisted → closed
                                               → escalated_counsel ↘
                                     (clock paused)  counsel_return → decided
under_review → closed_referred   (reclassification: a question, not a claim;
                                  no merits decision, no enforcement)
counter-notice overlay (item level, delist default):
  upheld_pending_counter → counter_notice_filed → restore_window → restored_after_counter_notice
                                                                    → closed
                                                                  → refiled → escalated_counsel
withdraw overlay: any open state → withdrawn → closed
reopen: closed → reopened (≤30 days, links to history) → under_review
```

illegal transitions throw (same discipline as ticketing). counsel
escalation pauses the decision clock; the pause interval is an
event pair (paused/resumed) so time-to-decision subtracts exactly.

## 16. event types (append-only)

claim_submitted, claim_bounced, contact_gate_verdict,
rate_limited, merged_amendment, evidence_requested,
evidence_attached, reviewer_assigned, hours_logged,
provisional_delisted, provisional_restored, creator_notified,
counter_notice_filed, restore_window_started,
restored_after_counter_notice, decision_recorded (signed),
escalated_counsel, counsel_clock_paused, counsel_clock_resumed,
enforcement_step_signed, registry_entry_added,
registry_entry_removed, claim_reopened, claim_closed, claim_reclassified_question,
question_asked, question_deflected, question_answered, question_closed,
retention_expired.

## 17. measurement (from events only)

no separate tracking pipeline to drift out of sync:

- claims per 1000 listings per month (listing counts from the
  marketplace port, volumes from events)
- substantiation rate: upheld items / decided items (withdrawn
  items counted separately, never as unsubstantiated)
- time from complete claim to decision, counsel pauses subtracted
  exactly (pause event pairs)
- false-positive delists restored (provisional_delisted +
  rejected_restored on the same item)
- reviewer hours per claim → the support-cost export
- bounce rate, resubmission completion rate (is the bounce
  understandable?), provenance-shortcut share (claims resolved by
  the shortcut), type-correction rate
- question traffic: share of public entries that fork to a
  question, inquiry deflection rate (answered by content, never
  reaching the human queue), reclassification rate in both
  directions (is the fork legible?)

## 18. edge cases (each a branch, each tested)

- **multi-listing claims**: per-item provisional measures and
  outcomes; one claim, three items, mixed outcomes — the claim
  closes on last item decision.
- **repeat claims, different claimants, same listing**: each claim
  reviews independently; the evidence view surfaces prior decisions
  on the listing (context, never a verdict).
- **coordinated campaigns**: rate-limit trips + review of the
  pattern is a signal to moderation (signals never verdicts); the
  campaign itself never auto-blocks filing.
- **claim against a delisted listing**: no provisional measure;
  review proceeds; prior history visible.
- **claimant unreachable mid-review**: the claim proceeds on the
  record; notification failures are logged; outcomes publish to the
  status view regardless.
- **claimant is (or becomes) a platform account holder**: the
  claimant block stays external-record; no bin/cin is ever attached
  to the claim; the parallel systems stay separate.
- **statute drift**: restore windows and dmca elements are config
  versioned; a statute bump is a config change + counsel review, not
  a code change.
- **question at the claim gate**: an asker past the fork who is
  really asking a question gets reclassified, referred, and answered
  — never bounced through the completeness gate to force claim
  fields they do not have.
- **claimant refuses contact but wants an answer**: the inquiry path
  is the only part of the system where contact is optional; claims
  always require it (a decision must be deliverable).

## 19. build phases

1. **core.** claim + item + event schemas, state machine,
   completeness gate, bounce-exactly-once, account-free intake,
   the question fork (inquiry records, public-content deflection,
   the single public-questions queue), contact gate, rate limits,
   duplicate merge.
2. **evidence.** ports: similarity report, release history,
   provenance lookup, chain of title, watermark trace; artifact
   attachment; the provenance shortcut decision path.
3. **provisional + dmca.** marketplace delist/restore port,
   notify-only mode, counter-notice loop, restore window,
   clock-pause events.
4. **decisions + ladder + registry.** signed decision records,
   outcomes, enforcement evidence events, policy-gated registry,
   privacy-scrubbed claimant status view.
5. **measurement + tuning.** the export, substantiation rate,
   reviewer hours, per-type tuning against real volume.

each phase ends with the previous behavior intact: phase 1 alone
already guarantees nothing is lost and nothing moves without a
signed human.

## 20. acceptance criteria (expanded, testable)

1. an incomplete claim bounces exactly once, listing the specific
   missing elements; a complete claim never requires an account
   (test: file without any session).
2. the template-provenance shortcut resolves items with the
   provenance explanation attached to the decision record.
3. every delist, restore, and ladder step traces to a signed human
   decision event (test: strip signatures → operations throw).
4. provisional delist and restoration are both first-class events
   with port refs (test: measure both from the log).
5. no dispute state ever changes a fee, trust, or ranking value
   (test: run every state transition against a snapshot of those
   values; assert byte-equality).
6. outside claimants see status only (test: the claimant view
   projection contains no creator personal or financial fields).
7. the daily export produces claim volume, substantiation rate,
   time-to-decision (counsel-paused), and reviewer hours from
   events only (test: rebuild the export from a fresh event log).
8. bounced resubmission links to the original claim; duplicate
   claims merge within the window, never double-review.
9. counter-notice restore fires only after the window with no
   refile; refile pauses the clock and moves the item to counsel.
10. registry entries require a signed human action citing policy
    (test: no event path creates one automatically).
11. a question never creates a claim record: the inquiry path
    produces inquiry events only, and no inquiry event can
    trigger a provisional measure, a decision, or a registry entry
    (test: enumerate event handlers against inquiry events).
12. a claim reclassified as a question closes as closed_referred
    with the referral link attached, excluded from the
    substantiation rate, and fires no enforcement event (test
    explicitly).
