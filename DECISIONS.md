# Decisions

A record of what was chosen, what was declined, and what was corrected. Kept
because the conclusions in this repository are only worth as much as the
reasoning behind them.

## Corrections made during the build

Each of these changed the product. Four of the five were found by instrumentation
rather than by reading the code.

### 1. The wrong question was being asked of Orbit

Every `integrate` call passed the whole deployment goal as its `task`, on the
assumption that more context would help.

Orbit replied `FIT: Not at all` and truncated the entire brief, returning no
`AUTH` and no `STEPS`. It was correctly judging one email endpoint against an
entire support-deflection programme.

**Changed:** `task` is scoped to the single capability. More context was actively
harmful, which is not what one would guess.

### 2. Missing evidence was read as "no authorisation required"

A clean URL with no key parameter was treated as an open endpoint. Brevo's
transactional email API scored zero days. It requires an API key.

**Changed:** the classifier became asymmetric. `NONE` is returned only on an
explicit Orbit statement; absence floors at `API_KEY` and raises
`AUTH_UNVERIFIED`.

### 3. A catalogue gap is not an internal system

When Orbit rejected every candidate, the result was scoped as custom work.
"Open an issue in a GitHub repository" returns only `GET` endpoints in the
catalogue, so every candidate was rejected, and the tool reported GitHub as a
sixty-day custom build. That is a worse error than the one being fixed.

**Changed:** `CATALOG_GAP` retains the vendor's real authorisation tier and flags
it for manual verification. Orbit emits a re-search hint on rejection, so the tool
now follows that hint automatically before giving up.

### 4. The strongest claim rested on an unstable signal, and the first fix cheated

A zero-result from Orbit drove the custom-build verdict and usually the headline
critical path. The same capability, phrased five ways, returned 0, 10, 10, 0 and
10 results. The verdict was a function of wording. The top hit for "internal wiki"
was Wikimedia Foundation.

The first fix re-probed with simplified paraphrases. That stripped the words
"internal company" and returned `NONE, 0 days, no flags` for an internal knowledge
base. The metric had been improved by asking an easier question.

**Changed:** internality markers (`our`, `internal`, `in-house`, `proprietary`)
are never stripped, because they are the capability. Any capability naming an
internal system that resolves to a public vendor raises a blocking
`INTERNAL_MISMATCH` and is scoped as custom work.

### 5. The same bug returned through a different phrasing

A cold-cache run scored Oracle Cloud object storage at zero days. Orbit had said:
"No authentication scheme is present in the supplied request or collection
context. Provide any authentication required by the Oracle API separately."

That is the collection author omitting authorisation, not an open API. The
classifier matched the words "no authentication" and took the optimistic reading.

**Changed:** *undocumented* ("scheme is not present", "provide separately") is now
separated from *genuinely open* ("no authentication is required"). Contract-gated
vendors can never score as no-authorisation.

**Note:** this survived three validation runs because every brief in the suite
happened to use clearer wording. A guard written against one phrasing is not a
guard against the failure.

## Defects the verification suite caught

- **A secret in a generated tool schema.** PagerDuty's `routing_key` was reaching
  an Anthropic tool schema. Secrets were filtered on the URL path but not on the
  brief-derived path. A model must never be able to select its own credential.
- **A dead user interface behind a passing suite.** A duplicate `const` in the
  inline script was a parse-time error, so the page rendered nothing while all
  server assertions passed. The suite tested the API and never loaded the page.
  It now parses the browser bundle and checks every element the script queries.
- **A one-line denial of service.** `POST /api/scan` with malformed JSON threw
  outside the try/catch and terminated the process. Request validation and
  process-level guards were added, with nine regression tests.
- **A rejected vendor counted as a real one.** The security-review vendor list
  included the vendor matched to a capability scoped as custom work, a vendor
  already rejected. The rule that emerged: never let a rejection read as a result.

## Declined

**Cost modelling.** The most requested addition a tool like this could have, and
Orbit carries no pricing data. Building it would mean inventing numbers and
presenting them beside real ones. There is already exactly one invented number,
fully labelled; a second would corrupt the first.

**Primary user research before building.** The forward-deployed motion is
documented publicly, and the premise here is grounded in that record rather than
re-derived through interviews. The standing of each claim is stated explicitly in
the case study rather than asserted. This is a deliberate trade and the reasoning
is open to challenge.

**Deploying the live tool publicly.** See the deployment note in the README. As
written this would be an unauthenticated endpoint consuming a shared rate limit.

## Known risks

| Risk | Status |
|---|---|
| Lead times are calibration, not measurement | Labelled throughout; isolated in `config.json` |
| Thin catalogue coverage yields confident wrong endpoints | Partly mitigated by `WEAK_FIT`, `CATALOG_GAP`, `VENDOR_UNREVIEWED`; not fully solved |
| Cannot see the customer's own tenant | Open. Vendor pinning is the intended fix |
| Critical path assumes perfect parallelism | Open. `max(days)` understates real timelines |
| Orbit's catalogue contains live credentials | Redacted on sight and never rendered; cache scanned before publication |

## Roadmap

In priority order.

1. **Vendor pinning.** Let the engineer supply the customer's known stack. This
   retires most mis-resolution at its root rather than flagging it downstream.
2. **A real dependency graph.** The critical path is currently `max(days)`, which
   assumes perfect parallelism and therefore understates real timelines. Shared
   blockers, such as one security review covering five vendors, are not modelled.
3. **Ranges rather than point estimates.** OAuth at Slack is days; OAuth at
   Workday is months. A single number per tier is too coarse to commit against.
4. **Multi-resource briefs.** Orbit accepts several endpoints per `integrate` call
   and returns step threading. Preflight sends one, leaving sequencing information
   unused.
5. **Liveness probing.** No resolved endpoint is ever contacted. A DNS and TLS
   check on the host is nearly free and would independently catch sandbox hosts.
