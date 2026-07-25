# Glossary

The documents in this repo draw vocabulary from three unrelated worlds — German invoicing law,
document AI, and software testing — and several ordinary words mean something specific here. This is
the lookup table.

**If you read only one section, read [§E](#e--words-that-mean-something-specific-here).** It covers the
words most likely to be misread *without the reader noticing*: a finance-side reader seeing
"reconciliation" will reasonably assume matching an invoice against a bank statement, when here it means
checking an invoice against *itself*.

| Section | |
| --- | --- |
| [A · Reading an invoice](#a--reading-an-invoice) | the document domain, and German tax specifics |
| [B · How InvEx works](#b--how-invex-works) | the pipeline, end to end |
| [C · The AI parts](#c--the-ai-parts) | what the models do, and what they cost |
| [D · Testing vocabulary](#d--testing-vocabulary) | needed for [REVIEW.md](./REVIEW.md) and [docs/known-bugs.md](./docs/known-bugs.md) |
| [E · Words that mean something specific here](#e--words-that-mean-something-specific-here) | **the disambiguation table** |
| [F · Deployment](#f--deployment) | needed for [DEPLOYMENT.md](./DEPLOYMENT.md) |

---

## A · Reading an invoice

**closed set** — The complete list of VAT rates a German invoice may legally use: 19 %, 7 % and 0 %.
Because the list is short and known, it doubles as evidence: a rate outside it is suspicious, and a
missing rate can sometimes be deduced from the amounts alone. → [repair](#b--how-invex-works)

**IBAN** — A bank account number. InvEx cares about it less as a payment detail than as a *vendor
fingerprint*: it carries a checksum, so a mis-read one fails arithmetically rather than silently
matching the wrong supplier. It is the third-choice identifier because it changes when a vendor switches
bank. → [vendor resolution](#b--how-invex-works)

**Kleinunternehmer (§19) / reverse charge (§13b)** — Two entirely different rules with the same visible
effect: an invoice that legitimately shows **0 % VAT**. A Kleinunternehmer is a small business exempt
from charging it; under reverse charge the *buyer* owes the tax instead of the seller. Both produce
documents that look broken to naive validation, which is why they get named explicitly.

**line item** — One row of the invoice's goods-and-services table. Treated as first-class here: the
description is mandatory, and quantity, unit price and per-line tax rate are optional because the system
can often reconstruct them.

**net / tax / gross** — The price before VAT, the VAT itself, and what you actually pay. Every
arithmetic check in the system hangs off `net + tax = gross`. Note that line totals are always **net**
in this system's output, even when the invoice printed them including VAT.

**over-determined** — An invoice states more numbers than are strictly necessary: the lines, the
subtotal, the VAT breakdown and the total all describe the same money. That redundancy is what lets
InvEx both *cross-check* the figures and *reconstruct* missing ones. It is a property the design
exploits, not a criticism.

**Steuernummer** — The other German tax number, issued by a local tax office. Weaker than a USt-IdNr as
an identifier because there is no nationwide checksum, but it matters because small businesses often
have only this one. → [USt-IdNr](#a--reading-an-invoice)

**USt-IdNr** — The German/EU VAT identification number: `DE` plus nine digits. It is checksum-verifiable
and globally unique, which is why it is InvEx's primary way of recognising which supplier sent a
document. → [vendor resolution](#b--how-invex-works)

**VAT breakdown** — The per-rate table on an invoice: "of this total, €1,148.70 was taxed at 19 %, giving
€218.25". An invoice with two rates has two rows.

**ZUGfERD / Factur-X / XRechnung / CII** — Four names around one idea: an ordinary-looking PDF with a
complete, machine-readable XML invoice embedded inside it. ZUGfERD is the German name, Factur-X the
French one for essentially the same thing, XRechnung the German public-sector variant; **CII** (Cross
Industry Invoice) is the XML dialect they all use inside. This is InvEx's cheapest and most reliable
input — nothing has to be *read* off the page at all. → [Path A](#b--how-invex-works)

---

## B · How InvEx works

**band** — The classifier's verdict bucket: `invoice`, `non_invoice`, or `uncertain`. Not a confidence
percentage — a bucket the score falls into. ⚠ "Band" also means something else entirely in the OCR code;
see [§E](#e--words-that-mean-something-specific-here).

**canonical invoice** — The single fixed JSON shape every path must produce, whatever route the document
took. A ZUGfERD invoice, a scanned one and one read by the AI all come out identical in structure, which
is what makes the output usable downstream.

**classifier** — Decides whether a document is an invoice at all. Despite the name it is **not machine
learning**: it adds up six hand-picked yes/no signals (is there an invoice-shaped number? a VAT block? a
tax ID?) with hand-set point values, then buckets the score into a → band. The weights are marked
provisional and are meant to be tuned against real documents.

**constraint solver** — The component that checks an invoice's arithmetic *and* fills in what is
missing. See → reconciliation, → repair, → violation. Referred to throughout simply as "the solver".

**cost ladder** — The system's central idea: cheap deterministic code first, the GPU model only if that
fails, a human only if that fails too. Each rung costs orders of magnitude more than the one below.
→ escalation. ⚠ [DEPLOYMENT.md](./DEPLOYMENT.md) also has a *timeout* ladder — an unrelated set of nested
time limits.

**deterministic path** — Plain, rule-based code running on an ordinary CPU: no AI, effectively free,
milliseconds per document. Maximising the share of invoices handled here is the stated design centre of
the whole system.

**escalation** — Moving a document *up the cost ladder* when the cheaper method could not finish it.
Crucially **not a failure**: every escalation also produces a → vendor template, so the same vendor's
next invoice is handled cheaply. → feedback loop

**feedback loop** — The mechanism that makes the system get cheaper with use: every expensive read (by
the AI or by a person) records how that vendor lays out their documents, so the next one is read by the
deterministic path. It works because invoice volume is concentrated in a few suppliers whose layouts
rarely change.

**lexicon** — The dictionary of label synonyms the rule engine matches against: that "Rechnungs-Nr.",
"Invoice No." and "Beleg-Nr." all mean the same field. → rule engine

**Path A / Path B / Path C** — The three routes a document can take, cheapest first. **A** — embedded
e-invoice XML, just read the data. **B** — a PDF with real selectable text, read the text and its
layout. **C** — a scan, i.e. a picture of a page, which needs OCR. Also called *routes* or *lanes*.

**poison document** — One file that crashes the worker every time it is tried. Because the queue is
processed oldest-first and a crash does not count as an attempt, it is picked up again on every restart
and blocks everything behind it. With a single → replica there is nothing else to pick up the work.

**reconciliation** — Checking an invoice's numbers **against itself** — not against a bank statement or a
purchase order. See [§E](#e--words-that-mean-something-specific-here); this is the term most often
misread.

**repair** — Filling in a value the invoice never printed but which can be computed with certainty from
the others: an unstated quantity of 1, a unit price derived from the line total. A repair only ever fills
a *gap*; it never overwrites a printed number, and numbers that contradict each other escalate instead.
→ violation

**rule engine** — The generic, vendor-agnostic reading logic used when no template exists yet: find a
known label, take the number next to it. Every first-seen vendor goes through this. → lexicon

**segmentation** — Splitting one PDF that contains several invoices into separate documents, or shearing
off appended terms and conditions, *before* extraction — otherwise table extraction merges unrelated
content.

**template** → see **vendor template**, and [§E](#e--words-that-mean-something-specific-here).

**template induction / template application** — Two halves of the feedback loop that are easy to
confuse. **Induction** is *learning* a template from an invoice that was successfully read.
**Application** is *using* that template on the vendor's next invoice.

**terminal status** — A state the system will not move a document out of on its own: extracted, exported
as Markdown, awaiting human review, split into children, or failed. Anything else means work is still in
progress.

**text gate** — A check on whether a PDF's built-in text layer is real words or garbled junk (someone
else's bad OCR, or a broken font). Junk is rerouted to the image path rather than trusted. → Path C

**tolerance** — How many cents of rounding slack a check allows before calling it a contradiction — ±0.02
on the header totals, ±0.01 per line. Without it, ordinary rounding would make correct invoices fail.

**trace** — The timestamped, append-only record of every step a document went through. It is why you can
always ask *why* a document ended up where it did, rather than reconstructing it from logs.

**triage** — The first, cheap look at a PDF that decides which of the three paths it takes. ⚠ Also used in
its ordinary human sense in [REVIEW.md](./REVIEW.md) ("a real invoice you triage").

**vendor resolution** — Working out which supplier sent a document so the right template can be applied.
Tries the identifiers in order of reliability: USt-IdNr, then Steuernummer, then any IBAN, then a hash of
the vendor's name and postcode.

**vendor template** — A learned, per-supplier reading map: where on *this* vendor's layout the invoice
number sits, what they call the total, which table column holds the quantity. **Not** a document template
you fill in and print. → [§E](#e--words-that-mean-something-specific-here)

**violation** — A constraint that failed — the numbers contradict each other. Violations are what cause a
document to escalate. The pairing with → repair is the whole accept-or-escalate decision: a repair is a
gap filled, a violation is a contradiction that could not be.

**worker** — The background process that actually pushes documents through the pipeline, separate from
the API that receives them. This is why submitting a PDF returns immediately and the result must be
polled for.

---

## C · The AI parts

**cold load** — When the GPU has to load a model into memory before it can answer. Measured at 1 m 29 s
to 2 m 38 s in the reference deployment — so a cold load costs more than the extraction itself, and it is
the single number that justifies trying so hard to avoid the GPU. → model residency

**docling** — A separate service InvEx sends PDFs to for page-layout analysis and OCR. It is what turns
"a PDF" into "text with positions and tables". **TableFormer** is the model inside it that recognises
table structure — the thing that finds the line-item grid.

**LiteLLM alias** — A stable nickname for a model (`doc-vision`, `ha-agent`) that carries its own timeout
and fallback policy. Callers bind to the alias, never to a raw model name, so the model underneath can
change without breaking anything.

**model residency** — Whether a model is currently sitting in GPU memory. Only one large model fits at a
time, so a request for a different one evicts it — and the next request for the first pays a → cold load.
Note that "never idle-unloaded" is *not* the same as "always resident": it only disables the idle timer.

**OCR** — Optical character recognition: turning a picture of a page into text. Note InvEx uses it
deliberately *cheaply* on Path C — initially only to spot the vendor's identifiers, not to read the whole
invoice.

**schema-constrained decoding** — Forcing the AI model to answer in exactly the required JSON shape, so
it *cannot* return something malformed. Only the correctness of its numbers remains to be checked — the
structure is guaranteed by construction.

**VLM (vision language model)** — An AI model that looks at a *picture* of the page and reads it. In
InvEx it is strictly an escalation, it is off by default, and each call costs seconds to minutes of GPU
time. → cost ladder

---

## D · Testing vocabulary

**"agrees with itself"** — The circular-test flaw at the centre of [REVIEW.md](./REVIEW.md). The old
suite generated the expected answers with the same code that generated the test documents, so it could
only ever confirm the code was consistent with itself — never that it was *correct*. Also written as "the
suite could not fail for the right reason".

**adversarial corpus** — A deliberately hostile set of inputs — malformed PDFs, absurd filenames,
oversized files — used to prove the system degrades safely rather than falling over. Its acceptance
criterion is one sentence: ingest every one of them, and a good invoice must still work afterwards.

**`[current]` test** — A plain, passing test recording what buggy code does *today*, written alongside
each → pin. Without it, a change to some third, different wrong behaviour would go unnoticed, because the
pin passes for any failure.

**coverage (line vs branch)** — The share of code a test run actually executed. **Line** coverage counts
lines that ran; **branch** coverage counts *decisions* exercised both ways. The review's point: the suite
sat at 89 % line coverage while eleven serious defects were live, because the tests *executed* nearly
everything and *asserted* very little. Branch coverage is the harder number to fake, and the honest one
to watch.

**draft golden / reviewed golden** — A **draft** is a scenario generated from the pipeline's own output,
marked `reviewed: false`. It is a starting point for a human, never an expected answer — using one as an
oracle would just assert that the pipeline agrees with itself. Once a person has read the real PDF and
corrected it, `reviewed: true` allows it to be used. → the labeling loop

**golden / golden scenario / golden corpus** — One test case held in a single file with two halves: the
literal ink on the page ("1.148,70", as printed), and the invoice a competent human reading that page
would type. The **corpus** is the whole collection. Called "golden" in the sense of a golden master — a
reference answer everything is compared against. → oracle

**independently authored halves** — The design rule that makes a golden trustworthy: the printed page and
the expected answer are written by hand, in different notations, and the pipeline is the *only* thing
claiming to connect them.

**`it.fails()`** — An inverted test: it **passes while the code is wrong** and **fails the moment the
code becomes right**. This is what makes a → pin a tripwire in both directions — the bug cannot be
forgotten, and it cannot be fixed without someone noticing.

**known bug / pin** — A defect deliberately left unfixed but recorded in code by a test asserting it is
still broken. "Pinned" means nailed in place by an executing test rather than a note in a wiki. Each
carries an `INVEX-nnn` id joining a row in [docs/known-bugs.md](./docs/known-bugs.md), a test, and a
paragraph in [REVIEW.md](./REVIEW.md).

**lane** — One slice of the test suite (`unit`, `component`, `integration`, `e2e`, and so on), defined by
what its tests own and the cheapest machinery that can hold them; each runs on its own. ⚠ "Lane" also
means a *pipeline path*; see [§E](#e--words-that-mean-something-specific-here).

**the labeling loop** — How the test corpus grows from reality: drop a real invoice in, see what the
pipeline made of it, generate a draft scenario from that, **correct it by hand**, commit. Every real
document you triage becomes a permanent regression test — and enough of them would finally provide the
labelled sample the classifier needs for tuning.

**oracle** — The independent statement of what the right answer *is*. Without one, a test can only show
that code is self-consistent; with one, it can show the code is wrong. Here the oracle is the
hand-written expected invoice inside each → golden.

**PGlite** — Real PostgreSQL compiled to WebAssembly and run inside the test process, so the full
pipeline can be tested without a database server or Docker. Its one limitation matters: it has a single
connection, so genuinely concurrent behaviour cannot be tested there at all.

**property-based test / invariant** — Instead of one example, states a rule that must hold for *every*
input, and lets the tool generate hundreds of random inputs trying to break it. The rule is the
**invariant** — for instance, "converting an amount to text and back must return the original", which is
how a 100× magnitude error gets caught.

**ratchet** — A one-way gate: a number that may only go up, or a list that may only shrink. Used here for
coverage thresholds and for the list of files still allowed to use retired code, so neither can slip back
quietly.

**red / green** — A failing test run and a passing one. **Red-before, green-after** is the evidence
standard for every fix in this review: the test was shown to fail against the old code and pass against
the new, which proves it actually tests the fix. Note one deliberate inversion: `pnpm test:known-bugs` is
*expected* to be red, and that red **is** the report.

**registry / meta-test** — A test *about the tests*: it reads the known-bugs table and the test sources
and fails if either mentions an id the other does not. It is why the documented backlog cannot drift away
from what the code actually checks.

**regression test** — A test written for a specific bug, kept forever so the bug cannot come back.

**round trip** — Convert a value out and back again and require the original. Cheap, and unusually good
at catching magnitude errors — a wrong decimal separator survives most checks but never survives a round
trip.

**seam** — A single chokepoint that everything is generated through, so different representations of the
same thing cannot drift apart. The fixture layout seam is why a test PDF and the test data describing it
can no longer disagree about what is on the page.

**smoke test** — A quick end-to-end sanity run over a folder of PDFs: submit each, wait for a final
status, print one row per document showing the path it took.

**synthetic vs real** — **Synthetic** documents are manufactured by this repo; **real** ones are actual
invoices you received. Every finding in the review was inferred from synthetic documents — stated
explicitly as a limitation, because a synthetic corpus is a guess about invoices and a real one is a
record of yours.

**test double (stub / fake)** — A stand-in that replaces a real external service during a test. A
**stub** returns canned answers you scripted; a **fake** has a real but simplified implementation. A
**mock** additionally asserts on how it was called — a term this repo deliberately avoids, preferring a
real local server so that timeouts and connection resets are genuine rather than simulated.

---

## E · Words that mean something specific here

### Familiar words, unfamiliar meanings

| Word | You'd reasonably assume | Here it means |
| --- | --- | --- |
| **reconciliation** | matching an invoice against a bank statement or purchase order | checking an invoice's numbers **against itself** — does net + VAT equal the gross it printed? |
| **template** | a document you fill in and print | a learned **reading map** of one supplier's layout: where their invoice number sits, which column holds the quantity |
| **escalation** | a support ticket, or a failure | moving a document **up the cost ladder** (CPU → GPU → human). Explicitly not a failure: it is also how the system learns |
| **repair** | fixing a wrong number | **filling in a number the invoice never printed** but which follows from the others. It never overwrites a printed value |
| **committed** | a git commit | a document **accepted and stored as a finished invoice** — the successful end state |
| **induction** | electrical, or logical, induction | **learning** a vendor template from an invoice that was read successfully |
| **provenance** | art or supply-chain history | a per-field record of **where each value came from** — read off the page, applied from a template, or reconstructed by the solver |
| **over-determined** | over-specified, a criticism | a **useful property**: the invoice prints more numbers than needed, so they can check each other |

### Words used for two or three different things

**band**
1. *Classifier band* — the verdict bucket: `invoice` / `non_invoice` / `uncertain`.
2. *OCR column band* — a vertical strip of the page used to work out which table column a number belongs
   to.
*Telling them apart:* if it is next to "classifier" or "uncertain", sense 1; if next to "column", "x-" or
"OCR", sense 2.

**claim**
1. *The worker claims a document* — takes exclusive ownership of it so no other worker touches it.
2. *A storage claim* (`claimRef`, PVC) — a Kubernetes disk reservation.
*Telling them apart:* sense 2 only appears in [DEPLOYMENT.md](./DEPLOYMENT.md)'s storage sections.

**corpus**
1. *Golden corpus* — documents that should be read correctly.
2. *Adversarial corpus* — documents that should fail **safely**.
*Telling them apart:* opposite purposes, always qualified by which one.

**fixture**
1. *A sample document* — a synthetic invoice PDF manufactured to feed the pipeline in a test. This is
   what `packages/fixtures` and `fixtures-drop/` mean.
2. *Test setup* — in the test framework's sense, the private database and fresh stand-ins handed to each
   test.
*Telling them apart:* sense 1 is a thing you could print; sense 2 is scaffolding.

**gate**
1. *The text gate* — the product's check on whether a PDF's text layer is usable.
2. *A CI gate* — an automatic check that blocks the build until it passes.
*Telling them apart:* "text gate" is always named in full; "gates the build" is the other.

**lane**
1. *A pipeline lane* — a processing route through the product ("the text lane", "the image lane"),
   interchangeable with path/route.
2. *A test lane* — one slice of the test suite.
*Telling them apart:* if it is one of `unit`/`component`/`integration`/`e2e`, sense 2; if it is
text/image/zugferd, sense 1.

**pin**
1. *Pin a bug* — nail it in place with a test that asserts it is still broken.
2. *Pin a value* — fix it so a test is deterministic ("under a pinned locale").
3. *Pin a version* — lock a dependency ("still pins v1.26.0").

**smoke**
1. *`pnpm smoke`* — the command that runs a folder of PDFs through the system.
2. *The `smoke` block inside a golden file* — the declaration of what that run should produce.

---

## F · Deployment

**ClusterIP / no public route** — InvEx is reachable only from *inside* the cluster; it has no public
hostname. This is deliberate and is the entire security model, because the service has no login of its
own. Operator access is a temporary tunnel (`kubectl port-forward`).

**GitOps** — The cluster's configuration lives in git and is applied automatically. You change the
system by changing git; there is no manual `kubectl apply`, and anything not in git is removed.

**liveness / readiness probe** — Kubernetes' automatic health poke: if the service stops answering, it
gets restarted. The review's finding was that InvEx's probe could never fail, so it could not trigger the
restart it exists for.

**n8n** — A workflow-automation tool, deployed as the *intended* way to feed emailed PDF attachments into
InvEx. It is running but **not yet connected** — which matters, because wiring it changes the input from
"files we chose" to "arbitrary bytes from the internet".

**OOMKilled** — The container was killed for using too much memory. The mechanism behind the
→ poison document.

**`Recreate`** — A deployment strategy: on update, fully stop the old copy *before* starting the new one.
Chosen deliberately here — two overlapping copies would race each other on the database migration and the
work queue — at the cost of a short outage on every deploy.

**replica** — How many copies of the service run. InvEx runs exactly **one**, on purpose. Much of the
review's severity ranking follows from that: with one replica, anything that stops the worker stops
everything.

**retain ≠ backup** — Storage marked "retain" is not deleted when the application is removed. That
protects against accidental deletion; it is **not** a backup, and does not protect against corruption or
against the data being wrong.

---

*Something missing or unclear? The source documents are [QUICKSTART.md](./QUICKSTART.md) (what and why),
[README.md](./README.md) (architecture), [API.md](./API.md) (the wire contract),
[DEPLOYMENT.md](./DEPLOYMENT.md) (operations), [REVIEW.md](./REVIEW.md) (the code review) and
[invex-briefing.md](./invex-briefing.md) (the original design brief).*
