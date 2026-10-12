# BAT News Agent and Import from X

We built BAT's first 1,187 accidents by reading about 4,000 news articles by hand. The News Agent does that reading for us on a schedule: it searches free news sources for fresh Bengaluru road accidents and adds what it finds as **pending** accidents. An admin approves or rejects each one. The **Import from X** paste box does the same for Bengaluru Traffic Police posts on X.

Nothing the agent finds reaches the public map until an admin approves it.

## What one run does

1. **Search.** Fetches one Google News RSS search feed per query, plus one GDELT query, for the last 2 days. GDELT goes first because its links point straight at publishers. GDELT allows about one request every 5 seconds: if it answers "rate-limited", the agent waits 6 seconds and tries once more, then skips GDELT for that run (shown in amber as "GDELT: rate-limited, skipped", not as a failure). Results are merged and URLs cleaned (tracking parameters and fragments dropped). Then it drops:
   - URLs already processed (`server/data/agent-seen.json`)
   - URLs already in `accidents.link`
   - headlines that are near-identical to another one in this run or in the last 7 days
2. **Pre-filter.** A free keyword check on the headline and snippet. English: accident, collision, crash, overturn, mishap, hit-and-run, run over, mowed, rammed, skid, killed, injured, dies, pile-up. Kannada: ಅಪಘಾತ, ಡಿಕ್ಕಿ, ಸಾವು.
3. **Triage.** Sends up to 30 headlines per AI call: "which of these is a specific road crash in Bengaluru?" The AI answers with numbers and a short reason. A triage call may use up to 3 attempts (one per model in `AGENT_MODELS`). If triage fails, the headlines are retried next run; a headline that fails triage 3 runs in a row is finished as `error` ("AI could not judge this headline") so it is not retried forever. Runs held back by the budget or a rate limit don't count as failures.
4. **Read.** For each kept item, up to `AGENT_MAX_READS_PER_RUN`:
   - **Google News link:** requested once to see whether it redirects to the publisher. If it stays on Google, the Google page is never read or parsed: the agent uses the headline and snippet and keeps the Google link.
   - **Publisher link:** the page is fetched through `safeFetch` (SSRF-checked on every redirect, 15 s timeout, 2 MB cap) and its article text extracted.
   - **Over the limit:** items over the read limit wait in a small queue for the next run, so they don't cost another triage call.
5. **Import** (`pipeline.mjs`, shared with the X importer):
   1. Exact link match against `accidents.link`, before any AI call. A match means skip, no insert.
   2. One AI call (at most 2 attempts) extracts: is it a real crash, is it in Bengaluru, location, area, date, time, severity, vehicles, a one-line English summary, and the publisher. The article is placed in a delimited data block that the AI is told to treat as data, never instructions. Every field is validated, and the date must not be in the future or older than 60 days.
   3. Geocode (Nominatim, at most 1 request per second). Coordinates outside lat 12.7–13.25, lng 77.35–77.85 are dropped and the admin sets the pin.
   4. `find_duplicates_by_point` (300 m, same date). A nearby record still gets inserted, but its description starts with "Possible duplicate of #id".
   5. Insert with `status = 'pending'` and `reporter_id = null`, the same way as `POST /api/reports` (Supabase insert, then `set_accident_geom`, with a Postgres fallback).
      - Title: "Fatal accident: Hosur Road near Silk Board junction"
      - Source: the publisher name
      - Link: the article
      - Description: the summary followed by "(Found by BAT News Agent)"
6. **Remember.** Every URL that got an outcome is added to the seen-list. Items held back by the AI budget, a rate limit or a temporary network error are not added, so a later run tries them again.

Every item ends with one of: `imported`, `duplicate`, `not_accident`, `outside_bangalore`, `invalid_link` or `error`. The admin run log shows a status and reason for each, for example "not in Bangalore", "duplicate of #812" or "imported #1190 (possible duplicate of #812)".

## Why everything is pending

- **AI makes mistakes.** It misreads places, dates and severity, and some headlines are about old crashes, court cases or crashes outside the city. A person checks each one against the source before it counts.
- **The public data stays trustworthy.** The dashboard, trends, risk model and Ask BAT only use approved (`active`) rows. Pending rows never go into the public `Frontend/accident_data.json`.
- **Pins need a human.** Many news reports only name an area, so the admin may need to drag the pin to the right spot (Edit) before approving.

## Sources and their terms

| Source | What we use | Terms / notes |
|---|---|---|
| Google News RSS search (`news.google.com/rss/search`) | Headline, link, publisher, date | Free public RSS feeds. We read the feed only; Google Search result pages and Google News pages are never scraped. Google offers these feeds for personal, non-commercial use (BAT is a non-commercial public-safety project; check Google's terms before any other use). |
| GDELT DOC 2.0 API (`api.gdeltproject.org/api/v2/doc/doc`) | Article URL, title, domain, first-seen time | Free and open; GDELT asks for attribution and at most one request every 5 seconds. The agent sends one GDELT request per run. |
| Publisher article pages | Article text, `og:site_name` | At most `AGENT_MAX_READS_PER_RUN` pages per run, with a user agent that names the bot (`BATNewsAgent/1.0`). We store a one-line summary and the link, never the article text. |
| X oEmbed (`publish.x.com/oembed`) | Post text, author | X's free official embed endpoint, used only by the admin paste box. x.com pages are never fetched, and no Nitter, RSSHub or unofficial APIs are used. |

## AI budget

Free OpenRouter models allow about 50 calls a day, shared by the whole site (Ask BAT, the digest, integrity checks and this agent). `AI_DAILY_LLM_BUDGET` (default 45) is the site-wide cap.

- At most `AGENT_MAX_AI_CALLS_PER_RUN` calls per run (default 8) and `AGENT_DAILY_AI_BUDGET` per day (default 20). The day is the IST day, and the count is kept in `server/data/agent-state.json`.
- Every attempt counts, including a retry after a malformed reply. A triage batch uses at most 3, a single article at most 2.
- Models are tried in the `AGENT_MODELS` order. A malformed reply retries the same model once; an empty reply or an HTTP error moves to the next model.
- Every request carries OpenRouter's reasoning control (`reasoning: { effort: "low", exclude: true }`, set by `AI_REASONING_EFFORT`). Reasoning ("thinking") models count their thinking against `max_tokens`; without this, Nemotron could spend the whole budget thinking and return an empty reply. Models that don't reason ignore it.
- Token limits: triage 4,000, extraction 2,500.
- No AI step starts while fewer than 10 site-wide free calls are left, so Ask BAT keeps working.
- A 429 (rate limit) from OpenRouter ends the run at once.
- When a limit is hit, the run log says "budget reached" and the remaining items wait for the next run.
- **X imports** don't use the agent's daily budget, but they obey the same "keep 10 spare" rule and stop at a 429.

## Settings (`server/.env`, see `server/.env.example`)

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_ENABLED` | `true` | `false` turns the agent off completely: no scheduled runs, and Run now / Backfill are refused. |
| `AGENT_INTERVAL_HOURS` | `3` | Hours between runs (minimum 1). The first run is 2 minutes after startup. Runs never overlap. |
| `AGENT_QUERIES` | `Bengaluru accident\|Bengaluru road accident killed\|Bengaluru crash injured\|Bengaluru hit-and-run\|ಬೆಂಗಳೂರು ಅಪಘಾತ` | Google News queries, separated by `\|`. Kannada queries use the Kannada edition. |
| `AGENT_MAX_READS_PER_RUN` | `8` | Articles read and checked per run. |
| `AGENT_MAX_AI_CALLS_PER_RUN` | `8` | AI calls per run. |
| `AGENT_DAILY_AI_BUDGET` | `20` | AI calls per IST day for the agent. |
| `AGENT_MODELS` | `google/gemma-4-31b-it:free,nvidia/nemotron-3-super-120b-a12b:free,openrouter/free` | Free models for triage, extraction and Import from X, in order. Paid ids are replaced with `openrouter/free`. |
| `AI_REASONING_EFFORT` | `low` | Reasoning effort sent to OpenRouter with every AI request (all features). `minimal`, `medium`, `high`, `none`, or `off` to send nothing. |
| `X_TRAFFIC_POLICE_HANDLES` | `blrcitytraffic` | X handles (comma-separated) labelled "Bengaluru Traffic Police (X)". Other handles are labelled "X: @handle". |

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
- **HTTP 429** on every attempt: the free daily limit is used up; try again tomorrow.

Exit code: 0 = triage works, 1 = no usable reply, 2 = `OPENROUTER_API_KEY` missing or AI turned off (no call made).

### Turning it off

Set `AGENT_ENABLED=false` in `server/.env` and restart the server. Nothing is scheduled, the admin buttons are disabled, and `POST /api/admin/agent/run` answers 409. Import from X keeps working because it only runs when an admin uses it.

## Files

| File | What it holds | Safe to delete? |
|---|---|---|
| `server/data/agent-seen.json` | Last 5,000 processed URLs | Yes |
| `server/data/agent-state.json` | Today's AI call count, the read queue, recent headlines | Yes |
| `server/data/agent-runs.json` | Last 50 run logs (titles, URLs, steps, reasons; no secrets) | Yes |

These files are git-ignored and best-effort: some hosts wipe them on every deploy. That is fine because the database link match is the real dedupe, so a wiped seen-list costs some extra AI calls but never creates duplicate rows. The daily AI count also resets with the file, which the site-wide budget in `llm.mjs` still caps.

## Admin

- **Admin → News Agent:**
  - Shows on/off, the next run, and AI calls used today out of the budget.
  - **Run now** starts a run; **Backfill last 30 days** asks for confirmation and searches 30 days under the same budgets.
  - The list shows recent runs. Click a run to see every article with a coloured status and the reason.
- **Admin → Import from X:** paste up to 20 Traffic Police post links, one per line, and get one result row per link. X links pasted into "+ Add Article" are sent here too.
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

## Tests

```
npm --prefix server test -- agent      # pipeline, agent, X import, routes (feeds, X, DB and AI all mocked)
```
