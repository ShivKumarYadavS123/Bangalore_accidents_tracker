# BAT News Agent and Import from X

We built BAT's first 1,187 accidents by reading about 4,000 news articles by hand. The News Agent does that reading for us on a schedule: it searches free news sources for fresh Bengaluru road accidents and adds what it finds as **pending** accidents. An admin approves or rejects each one. The **Import from X** paste box does the same for Bengaluru Traffic Police posts on X.

Nothing the agent finds reaches the public map until an admin approves it, or, in Auto mode only, until the **BAT Review Agent** approves it after its checks (see [BAT Review Agent](#bat-review-agent); it starts in Shadow mode, which changes nothing).

## What one run does

1. **Search.** For the last 2 days, in this order:
   1. **GDELT**, one query. Its links point straight at publishers. GDELT allows about one request every 5 seconds: if it answers "rate-limited", the agent waits 6 seconds and tries once more, then skips GDELT for that run (shown in amber as "GDELT: rate-limited, skipped", not as a failure).
   2. **Publisher feeds** (`AGENT_RSS_FEEDS`): the Bengaluru sections of The Hindu and The Times of India by default. Their links also go straight to the publisher. These feeds have no date filter, so items older than the search window are left out ("Feed: The Hindu: 3 older than 2 days, left out"). Only links on the feed's own site are kept.
   3. **Google News RSS**, one search feed per query. A Kannada query uses the Kannada edition (`hl=kn`) first; if that feed has no items, the same query is tried once on the English India edition (`hl=en-IN`), and the log says which edition gave the results.
   4. **Related links** kept from pages read in the last run (see step 4), shown under Sources as "Related links".

   A Google News or publisher feed that answers HTTP 404 or 5xx is tried once more after 3 seconds; if it fails again it is skipped for that run, in amber ("Google News: <query>: didn't answer (HTTP 404), skipped"), not as a failure. A feed with no items logs its HTTP status and content type (never the feed itself). Results are merged and URLs cleaned (tracking parameters and fragments dropped). Then it drops:
   - URLs already processed (`server/data/agent-seen.json`)
   - URLs already in `accidents.link`
   - headlines that are near-identical to another one in this run or in the last 7 days. Direct links come first, so when GDELT or a publisher feed has the same story as Google News, the direct link is kept and the Google copy costs nothing.
2. **Pre-filter.** A free keyword check on the headline and snippet. English: accident, collision, crash, overturn, mishap, hit-and-run, run over, mowed, rammed, skid, killed, injured, dies, pile-up. Kannada: ಅಪಘಾತ, ಡಿಕ್ಕಿ, ಸಾವು.
3. **Triage.** Sends up to 30 headlines per AI call: "which of these is a specific road crash in Bengaluru?" The AI answers with numbers and a short reason. A triage call may use up to 3 attempts (one per model in `AGENT_MODELS`). If triage fails, the headlines are retried next run; a headline that fails triage 3 runs in a row is finished as `error` ("AI could not judge this headline") so it is not retried forever. Runs held back by the budget or a rate limit don't count as failures.
4. **Read.** For each kept item, up to `AGENT_MAX_READS_PER_RUN`:
   - **Google News link:** a Google News link never reaches the publisher, so first the agent looks for the same story from the same publisher in this run's GDELT and feed results. It must have a near-identical headline, and the same site as the feed's `<source url>` or the same publisher name.
     - **Found:** the publisher's link is read instead, and the Google link is kept as a second link for the duplicate check. The log says "read the publisher's link from GDELT instead of Google News". If that link was already processed (seen before, already stored, or done earlier in this run), the item is finished as a duplicate with no read and no AI call.
     - **Not found:** the Google link is requested once to see whether it redirects to the publisher. If it stays on Google, the Google page is never read or parsed: the agent uses the headline and snippet and keeps the Google link.
   - **Publisher link:** the page is fetched through `safeFetch` (SSRF-checked on every redirect, 15 s timeout, 2 MB cap). From the page the agent takes:
     - **The story text.** If the page has JSON-LD (`application/ld+json`) of type `NewsArticle` or `Article` with an `articleBody`, that is the text. The AI reads only the first 6,000 characters, so menus and "trending" lists must not push the story out. Otherwise the article text is extracted from the HTML.
     - **`og:title` and the description** (`og:description`, else `meta description`). Both are sent to the AI, labelled. The description often names the place when the body doesn't ("Silk Board accident: ..."). Meta keywords are never read: they are SEO tags, often about other stories.
     - **The publish time** (`article:published_time`, or the JSON-LD `datePublished`), used when the item has no date of its own.
   - **Related links** (at most `AGENT_MAX_RELATED_PER_RUN` per run, default 3). From a publisher page that was read, the agent collects links in "Also Read" lines and related-story blocks. A link is kept only if:
     - it is on the same site;
     - its text passes the accident keyword check and names Bengaluru, Bangalore, ಬೆಂಗಳೂರು or a known place in the city;
     - it is not seen before, not in the database and not already in this run.

     Kept links are stored in `agent-state.json` and join the **next** run's search results. They then go through triage, read, extract, the date check, the duplicate check and the Bengaluru box like any other item. The run log says "RELATED: 2 links from Deccan Herald kept for the next run", and those articles show "related link from Deccan Herald". Links on a related page are not followed (one hop only). A related page published more than 60 days ago is finished without an AI call. Related links held back by the AI budget wait for the following run.
   - **Over the limit:** items over the read limit wait in a small queue for the next run, so they don't cost another triage call.
5. **Import** (`pipeline.mjs`, shared with the X importer):
   1. Exact link match against `accidents.link`, before any AI call. A match means skip, no insert.
   2. One AI call (at most 2 attempts) extracts: is it a real crash, is it in Bengaluru, location, area, date, time, severity, vehicles, a one-line English summary, and the publisher. The article (headline, og:title, description and text) is placed in a delimited data block that the AI is told to treat as data, never instructions. The AI is told it may use the description, and a police station named in the text ("Madiwala Traffic Police registered a case"), as clues to the place, but only for what the article itself states. A police station gives the area, not the exact spot. Every field is validated, and the date must not be in the future or older than 60 days. Summary and severity are required; the location is not (the AI is told to leave it empty rather than guess).
   3. **Grounding check.** When the AI gives a location, at least one significant word of the location or area must appear in the text the AI was given: the headline, og:title, description or article text (not the URL).
      - Generic words don't count: Bengaluru, road, near, junction, cross, layout, police, hospital and the like.
      - Joined words match too, so "Silk Board" matches "Silkboard".
      - **Not found:** the place is not trusted and the record is saved as "no exact place" (below). The run log says `place "..." not found in the article`; the guess never goes into the description.
      - **Kannada article** (at least 30% of the letters are Kannada): the AI writes places in English, so they can't be matched. The AI's place is kept as the location, but the record is **never pinned**, and the description says "(place from a Kannada article, not checked: check it and set the pin before approving)". A Kannada article that also writes the place in English letters is checked like any other.
      - The same check runs for Import from X.
   4. Geocode (Nominatim, at most 1 request per second), only for a checked place. Coordinates outside lat 12.7–13.25, lng 77.35–77.85 are dropped and the admin sets the pin. **No exact place** (common for headline-only Google News items): nothing is geocoded, the record is saved with the area as its location (or "Bengaluru (exact place not in the article)"), no pin, and "(no exact place: set the pin before approving)" in the description, so the admin places it with Edit.
   5. `find_duplicates_by_point` (300 m, same date). A nearby record still gets inserted, but its description starts with "Possible duplicate of #id".
   6. Insert with `status = 'pending'` and `reporter_id = null`, the same way as `POST /api/reports` (Supabase insert, then `set_accident_geom`, with a Postgres fallback).
      - Title: "Fatal accident: Hosur Road near Silk Board junction"
      - Source: the publisher name
      - Link: the article
      - Description: the summary followed by "(Found by BAT News Agent)". When the article page couldn't be read and only the headline was used, "(read from the headline only)" comes before the marker.
6. **Remember.** Every URL that got an outcome is added to the seen-list. Items held back by the AI budget, a rate limit or a temporary network error are not added, so a later run tries them again.
7. **Failed saves.** A save that fails is not a verdict on the article. The item is shown as Deferred, is not added to the seen-list, and goes back in the queue with the record the AI already built (extracted fields and location). The next run retries only the save: no reading and no AI call.
   - The reason is "could not save (<error>); will retry next run".
   - If the database still has the old status check that only allows Active rows, the reason is "database doesn't accept Pending records yet: the Supabase owner must run the accidents_status_check lines from Database/supabase-setup.sql; will retry next run". Nothing can be saved until that is fixed, so the rest of that run sends no more articles to the AI; the remaining items wait with the same reason.
   - After 5 runs of failed saves the item is finished as `error` ("gave up after 5 failed saves ...").
   - Import from X shows the same status-check reason, ending "import the post again once that is done".
   - One-off on upgrade: articles whose save failed before this behaviour existed (the latest result in the run history is an error at the save step) are taken off the seen-list once, so the next search picks them up again.

Every item ends with one of: `imported`, `duplicate`, `not_accident`, `outside_bangalore`, `invalid_link` or `error`. The admin run log shows a status and reason for each, for example "not in Bangalore", "duplicate of #812" or "imported #1190 (possible duplicate of #812)".

## Why everything is pending

- **AI makes mistakes.** It misreads places, dates and severity, and some headlines are about old crashes, court cases or crashes outside the city. A person checks each one against the source before it counts.
- **The public data stays trustworthy.** The dashboard, trends, risk model and Ask BAT only use approved (`active`) rows. Pending rows never go into the public `Frontend/accident_data.json`.
- **Pins need a human.** Many news reports only name an area, so the admin may need to drag the pin to the right spot (Edit) before approving.

## BAT Review Agent

A second agent (`review-agent.mjs`) double-checks the News Agent's pending finds and, in Auto mode, approves the ones it is sure about. **It never rejects anything:** a find it is unsure about stays Pending for a person.

### When it runs

- Right after every News Agent run (scheduled, Run now or Backfill).
- When an admin presses **Review now** (`POST /api/admin/agent/review`).

It looks only at pending rows the agent-row check counts as News Agent finds: `reporter_id` null and "(Found by BAT News Agent)" in the description. This is the same check that tags agent rows on the map (`store.agentRows`).
- A row it has already reviewed is skipped until the row changes (a hash of its fields).
- A row that stopped at check c is checked again on each run while its date is within 7 days, because a new find may corroborate it. These checks are free, and a repeated result isn't logged again.

### The checks

Cheapest first; the first failure stops the review with a reason.

| | Check | Needs a person when |
|---|---|---|
| a | Real data | No pin inside the Bengaluru box. Or the description has "(no exact place: set the pin before approving)", the Kannada note "(place from a Kannada article, not checked…)" or "(read from the headline only)". Or the link is a Google News link. Or the pin came from one of the Review Agent's own suggestions. |
| b | Date | `accident_date` is missing, in the future, or more than 7 days ago. |
| c | Corroboration | No other report on the same date within 500 m whose text says the same thing (similarity at least 0.75, local embeddings from `ai/integrity.mjs`, no AI call), from a **different publisher**. The publisher is compared by its name and by its link's site. The same publisher twice doesn't count. A corroborator is an active row, or a pending News Agent or X find that passes check a itself. Pending citizen reports don't count. The matching rows form one cluster. If the cluster includes an active row, the accident is already on the map, so a person decides. |
| d | Not a duplicate | An **active** row within 300 m on the same date (`find_duplicates_by_point` through the store, like the Finder). |
| e | AI check | One AI call through the News Agent's AI gate and model order (`AGENT_MODELS`), at most 2 attempts. The agent reads both publishers' pages again and asks: *"Given these two reports, is this one specific road accident in Bengaluru, and do the record's location and date match?"* The reply must be exactly `{ same_accident, is_road_accident, location_ok, date_ok, confidence 0-1, note }` with the right types. Anything else counts as a malformed reply. |

The decision is **auto_approve** only when a to d pass and the AI answers true to all four questions with confidence of at least 0.8. Everything else is **needs_human**, with the reason shown in the admin panel and the Review modal.

### Modes (`REVIEW_AGENT_MODE`, default `shadow`)

- **off:** nothing runs.
- **shadow:** decisions are recorded in `server/data/review-*.json` and nothing else happens. **Zero database writes**, and a test proves it.
- **auto:** an auto_approve sets the cluster's best row to `active`, using the same queries as the admin's Approve button (`server/admin-accident-write.js`).
  - The best row is the one with a time of day, then the longer report, then the older id.
  - " (Approved by BAT Review Agent)" is added to that row's description.
  - The other rows in the cluster are hidden with the rejection reason "merged into #id".
  - The map tags and the AI data cache are refreshed, as after an admin write.

An admin changes the mode in **Admin → News Agent → Review Agent**. Switching to Auto asks for confirmation first, and the API also requires `confirm: true`. The choice is kept in `server/data/review-state.json` (not the Finder's `agent-state.json`) and wins over the env value.

**Undo** (in the table, on rows marked "Agent-approved") puts the approved row back to Pending with its old description, and the rows it hid go back to Pending too. The Review Agent never auto-approves that accident again.

### Why it never rejects

A rejected find disappears from the queue, so a mistake there is silent: nobody looks at it again. A wrong approval is visible: it is badged "Agent-approved" on the admin table, it can be undone in one click, and it shows on the map where people notice it. So the agent only takes the action a person can easily check and undo, and everything else stays in the human queue, as it did before the agent existed.

### Why headline-only finds always need a person

When the article page couldn't be read (a Google News link that never reaches the publisher, an error page, too little text), the Finder only had the headline and a snippet. The place, date and severity are then the AI's reading of about 15 words, which is too little to approve without a person. The Finder now marks these rows "(read from the headline only)". Rows saved before that note existed are still caught when their link is a Google News link. A headline-only find can't corroborate another find either.

### Fix suggestions

For a pending find with no pin, or with "(exact place not in the article)", the agent may read the **publisher's** page again (never a Google page) and propose a title, location, area, accident date and pin. The proposal uses one AI call from the same daily budget, after the checks above.
- It is offered only when:
  - the place words appear in the article's title, description or text (`groundPlace` / `isPlaceGrounded` from `pipeline.mjs`);
  - the date is within 7 days and not in the future;
  - **the geocoder** puts the place inside the Bengaluru box.
- The AI never supplies coordinates, and any it sends are ignored.
- Kannada articles and finds older than 7 days get no suggestion.

Suggestions are **never applied automatically**, in any mode. They show in the Review modal of that find with an **Apply suggestions** button, which sends the same `PATCH /api/admin/accidents/:id` as Edit. A find whose pin came from a suggestion is never auto-approved: a person approves it.

### AI budget

`REVIEW_AGENT_DAILY_AI_BUDGET` calls per IST day (default 10, every attempt counts, kept in `review-state.json`). The Finder's rule still applies: no AI step while fewer than 10 site-wide free calls are left.
- Over budget, the remaining rows wait for the next run (waiting is not a decision).
- A busy model's 429 moves on to the next model.
- An account-level 429 stops the run.
- If the News Agent run just before ended on a 429, the review makes no AI call that time.

### Reading the agreement score

The panel shows "agreed with admins on N of M". When an admin approves or rejects (Approve, Reject, or the bulk buttons) a row the Review Agent judged itself, the agent compares that with its own decision.
- **auto_approve and the admin approved:** agree.
- **auto_approve and the admin rejected:** disagree.
- **needs_human:** not counted, because "a person should look" is never wrong. These are shown separately in `GET /api/admin/agent/review/stats` as `needsHuman: { approve, reject }`.
- Only the first admin decision on a row counts. An Undo isn't counted, but the approve or reject that follows it is.
- Approvals made with the status pill (the PATCH route) are not reported.

Run it in **shadow** until M is a few dozen and N/M is close to 1. Every disagreement is a find the agent would have published wrongly: read its reason in the Review modal before switching to Auto.

## Sources and their terms

| Source | What we use | Terms / notes |
|---|---|---|
| Google News RSS search (`news.google.com/rss/search`) | Headline, link, publisher, date | Free public RSS feeds. We read the feed only; Google Search result pages and Google News pages are never scraped. Google offers these feeds for personal, non-commercial use (BAT is a non-commercial public-safety project; check Google's terms before any other use). |
| GDELT DOC 2.0 API (`api.gdeltproject.org/api/v2/doc/doc`) | Article URL, title, domain, first-seen time | Free and open; GDELT asks for attribution and at most one request every 5 seconds. The agent sends one GDELT request per run. |
| Publisher RSS feeds (`AGENT_RSS_FEEDS`) | Headline, article link, date, summary | The publishers' own public feeds, one request per feed per run. Defaults: The Hindu Bengaluru (`thehindu.com/news/cities/bangalore/feeder/default.rss`) and The Times of India Bangalore (`timesofindia.indiatimes.com/rssfeeds/-2128833038.cms`), both checked in a browser. |
| Publisher article pages | Article text (JSON-LD `articleBody` or the HTML), `og:site_name`, `og:title`, description, publish time, related-story links | At most `AGENT_MAX_READS_PER_RUN` pages per run, with a user agent that names the bot (`BATNewsAgent/1.0`). We store a one-line summary and the link, never the article text. Related links are followed only on the same site, one hop, at most `AGENT_MAX_RELATED_PER_RUN` per run. |
| X oEmbed (`publish.x.com/oembed`) | Post text, author | X's free official embed endpoint, used only by the admin paste box. x.com pages are never fetched, and no Nitter, RSSHub or unofficial APIs are used. |

## AI budget

Free OpenRouter models allow about 50 calls a day, shared by the whole site (Ask BAT, the digest, integrity checks and this agent). `AI_DAILY_LLM_BUDGET` (default 45) is the site-wide cap.

- At most `AGENT_MAX_AI_CALLS_PER_RUN` calls per run (default 8) and `AGENT_DAILY_AI_BUDGET` per day (default 20). The day is the IST day, and the count is kept in `server/data/agent-state.json`.
- Every attempt counts, including a retry after a malformed reply. A triage batch uses at most 3, a single article at most 2.
- Models are tried in the `AGENT_MODELS` order. A malformed reply retries the same model once; an empty reply or an HTTP error moves to the next model.
- Every request carries OpenRouter's reasoning control (`reasoning: { effort: "low", exclude: true }`, set by `AI_REASONING_EFFORT`). Reasoning ("thinking") models count their thinking against `max_tokens`; without this, Nemotron could spend the whole budget thinking and return an empty reply. Models that don't reason ignore it.
- Token limits: triage 4,000, extraction 2,500.
- No AI step starts while fewer than 10 site-wide free calls are left, so Ask BAT keeps working.
- An OpenRouter 429 (rate limit) comes in two kinds:
  - **One free model is busy** ("... is temporarily rate-limited upstream", or its provider's limit): the next model in `AGENT_MODELS` is tried and the run carries on.
  - **The account's free allowance is used up** ("free-models-per-day" or "free-models-per-min"), or the reason can't be read: no more AI calls this run. The run ends as **Rate limited**, and waiting items show "AI rate-limited (HTTP 429); will retry next run".
  - If every model tried in one call answers 429, the run also ends as Rate limited.
- When a limit is hit, the run log says "budget reached" and the remaining items wait for the next run.
- **X imports** don't use the agent's daily budget, but they obey the same "keep 10 spare" rule and stop at a 429.

## Settings (`server/.env`, see `server/.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_ENABLED` | `true` | `false` turns the agent off completely: no scheduled runs, and Run now / Backfill are refused. |
| `AGENT_INTERVAL_HOURS` | `3` | Hours between runs (minimum 1). The first run is 2 minutes after startup. Runs never overlap. |
| `AGENT_QUERIES` | `Bengaluru accident\|Bengaluru road accident killed\|Bengaluru crash injured\|Bengaluru hit-and-run\|ಬೆಂಗಳೂರು ಅಪಘಾತ` | Google News queries, separated by `\|`. Kannada queries use the Kannada edition. |
| `AGENT_RSS_FEEDS` | The Hindu Bengaluru and The Times of India Bangalore feeds | Publisher RSS/Atom feeds, separated by `\|`. `off` turns them off. Only http(s), never Google, at most 10. |
| `AGENT_MAX_RELATED_PER_RUN` | `3` | Related-story links kept per run for the next run (0 to 10; 0 turns it off). |
| `AGENT_MAX_READS_PER_RUN` | `8` | Articles read and checked per run. |
| `AGENT_MAX_AI_CALLS_PER_RUN` | `8` | AI calls per run. |
| `AGENT_DAILY_AI_BUDGET` | `20` | AI calls per IST day for the agent. |
| `AGENT_MODELS` | `google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free` | Free models for triage, extraction and Import from X, in order. Paid ids are replaced with `openrouter/free`. |
| `AI_REASONING_EFFORT` | `low` | Reasoning effort sent to OpenRouter with every AI request (all features). `minimal`, `medium`, `high`, `none`, or `off` to send nothing. |
| `X_TRAFFIC_POLICE_HANDLES` | `blrcitytraffic` | X handles (comma-separated) labelled "Bengaluru Traffic Police (X)". Other handles are labelled "X: @handle". |
| `REVIEW_AGENT_MODE` | `shadow` | Review Agent mode: `off`, `shadow` (record only, no database writes) or `auto`. The admin's choice in the panel wins over this. |
| `REVIEW_AGENT_DAILY_AI_BUDGET` | `10` | AI calls per IST day for the Review Agent (checks and fix suggestions). |

The agent also needs `OPENROUTER_API_KEY` and a database (Supabase or `DATABASE_URL`). Without them it does not run, and the admin panel says why.

### Checking the AI (agent-ai-check.mjs)

Run this yourself after changing models or keys, or when runs show triage errors:

```
cd server
node scripts/agent-ai-check.mjs
```

It reads `server/.env` the same way the server does, sends **one** triage request with 5 sample headlines (2 Bengaluru crashes, 1 crash in Mumbai, 2 non-accidents) and prints every attempt: model, HTTP status, `finish_reason`, token usage (including reasoning tokens) and the reply. It uses 1 to 3 of the free daily calls and never prints your API key.

- **Working:** an attempt with `HTTP 200`, `finish_reason: stop` and a non-empty reply, then `PASS`. Headlines [1] and [2] should be `KEPT`.
- **Still broken:** `RESULT: FAIL` with every attempt showing `reply: (EMPTY)` / `finish_reason: length` and a large reasoning count. Try `AI_REASONING_EFFORT=minimal`, or put another free model first in `AGENT_MODELS`.
- **HTTP 429** with "rate-limited upstream": that free model is busy right now, and the next model is tried. Only a problem if every model says it; run the check again in a few minutes.
- **HTTP 429** with "free-models-per-day": the free daily limit is used up; try again tomorrow.

Exit code: 0 = triage works, 1 = no usable reply, 2 = `OPENROUTER_API_KEY` missing or AI turned off (no call made).

### Turning it off

Set `AGENT_ENABLED=false` in `server/.env` and restart the server. Nothing is scheduled, the admin buttons are disabled, and `POST /api/admin/agent/run` answers 409. Import from X keeps working because it only runs when an admin uses it.

## Files

| File | What it holds | Safe to delete? |
|---|---|---|
| `server/data/agent-seen.json` | Last 5,000 processed URLs | Yes |
| `server/data/agent-state.json` | Today's AI call count, the read queue (including saves waiting to be retried), related links waiting for the next run, recent headlines | Yes |
| `server/data/agent-runs.json` | Last 50 run logs (titles, URLs, steps, reasons; no secrets) | Yes |
| `server/data/review-state.json` | Review Agent: the mode an admin chose, today's AI call count, reviewed-row hashes, approvals (for Undo), undone rows, admin verdicts (agreement score), fix suggestions, the last 20 review runs | Yes, but the mode goes back to `REVIEW_AGENT_MODE`, the agreement score restarts, and Undo then only resets the approved row itself |
| `server/data/review-runs.json` | Review Agent: the last 500 decisions (row id, each check passed or failed, the AI verdict, the decision, the mode, the time), undos and suggestions | Yes |

These files are git-ignored and best-effort: some hosts wipe them on every deploy. That is fine because the database link match is the real dedupe, so a wiped seen-list costs some extra AI calls but never creates duplicate rows. The daily AI count also resets with the file, which the site-wide budget in `llm.mjs` still caps.

## Admin

- **Admin → News Agent:**
  - Shows on/off, the next run, and AI calls used today out of the budget.
  - **Run now** starts a run; **Backfill last 30 days** asks for confirmation and searches 30 days under the same budgets.
  - The list shows recent runs. Click a run to see every article with a coloured status and the reason.
  - **Review Agent** section: the mode (Off / Shadow / Auto; Auto asks first), AI calls today, "agreed with admins on N of M", **Review now**, and the latest decisions with their reasons.
- **Table:** rows the Review Agent approved get an **Agent-approved** badge and an **Undo** button (asks first, back to Pending).
- **Review modal** of a News Agent find: the Review Agent's verdict, each check, the AI's note, and any fix suggestion with **Apply suggestions**.
- **Admin → Import from X:** paste up to 20 Traffic Police post links, one per line, and get one result row per link. X links pasted into "+ Add Article" are sent here too.
- **Edit** (any record): besides the pin, location and area, an admin can fix the **Title** (5 to 200 characters) and the **Accident date** (YYYY-MM-DD, not in the future, IST). No Supabase Table Editor is needed.
  - Changing the date also sets `date_raw` to that date, keeping its time when it had one ("2026-10-12 23:30" becomes "2026-10-11 23:30").
  - Title and date are sent only when changed, and the server checks them again (`PATCH /api/admin/accidents/:id`, admin only; validation in `server/admin-accident-edit.js`).
- **Pending queue:**
  - **Pending Reports** shows every pending row: citizen reports, agent finds and X imports. Each gets Review / Approve / Reject.
  - Badges in the Source column mark "Agent" and "X" rows. The AI integrity pill appears on citizen reports only.
- **Public map:** approved agent rows (not citizen reports) read "Source: Deccan Herald (found by BAT News Agent)" with "Read article ↗". X rows read "Source: Bengaluru Traffic Police on X" only when the source is "Bengaluru Traffic Police (X)", "@handle on X" for "X: @handle" rows, and "Post on X" for any other x.com link, all with "View post on X ↗".

## API (admin JWT, rate limited)

| Method | Path | Notes |
|---|---|---|
| GET | `/api/admin/agent/status` | Enabled, next run, AI calls today, site-wide budget, last 10 runs |
| GET | `/api/admin/agent/runs/:id` | Full log of one run |
| POST | `/api/admin/agent/run` | `{ "backfillDays": 1-30 }` optional. 202 when started, 409 when a run is going or the agent is off |
| POST | `/api/admin/x-import` | `{ "urls": [...] }`, at most 20. One result per link, in order |
| POST | `/api/admin/agent/review` | Start a review. 202 when started, 409 when the Review Agent is off or already running |
| GET | `/api/admin/agent/review/status` | Mode, AI calls today, agreement, last runs, latest 20 decisions |
| GET | `/api/admin/agent/review/stats` | `{ agree, disagree, scored, decisions: { auto_approve, needs_human }, needsHuman: { approve, reject }, undos }` |
| GET | `/api/admin/agent/review/rows/:id` | The verdict, checks, AI note and fix suggestion for one row (Review modal) |
| POST | `/api/admin/agent/review/mode` | `{ "mode": "off" \| "shadow" \| "auto" }`; `auto` also needs `"confirm": true` |
| POST | `/api/admin/agent/review/undo/:id` | Undo a Review Agent approval: back to Pending (409 if the agent didn't approve it) |

## Tests

```
npm --prefix server test -- agent      # pipeline, agent, reading, X import, Review Agent, routes (feeds, pages, X, DB and AI all mocked)
npm --prefix server test -- admin-accident-edit   # Edit: title and accident date
npm --prefix Frontend test -- review-agent-ui      # Review Agent panel, badge, Undo, verdict, Apply; Edit save refreshes the row
```
