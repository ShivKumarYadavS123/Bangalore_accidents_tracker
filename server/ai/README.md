# BAT AI features

Five features, all built on **free** services only (no paid API anywhere).

| Feature | Page | What it does |
|---|---|---|
| Ask BAT agent | `ask.html` | Plain-English questions → an LLM agent calls allow-listed analysis tools → answer + chart + "how I got this" trace |
| Risk hotspot prediction | Dashboard → "Predicted risk" | Poisson regression on a 500 m grid predicts where the next incidents are likely |
| Safe route | `safe-route.html` | OSRM route alternatives scored by past incidents along each route + predicted risk |
| Weekly digest | Trends page (top card) | Facts computed from data → free LLM writes prose → every number is fact-checked |
| Integrity checks | Admin → Pending reports, Review modal, "Image check" | Semantic duplicates, spam/gibberish, fake/AI/edited/reused photo forensics |

## Free services used

| Need | Service | Cost / limits |
|---|---|---|
| LLM (agent, digest, optional vision check) | OpenRouter `:free` models (`nvidia/nemotron-3-super-120b-a12b:free` → `google/gemma-4-31b-it:free` → `openrouter/free`) | Free tier: about 50 requests/day, 20/min. Paid model IDs are refused in code. |
| Text embeddings | `Xenova/all-MiniLM-L6-v2`, runs locally (transformers.js / ONNX) | Free, offline after one ~23 MB download |
| AI-generated image detector | `onnx-community/SMOGY-Ai-images-detector-ONNX`, runs locally | Free, offline after first download |
| Image forensics | `sharp` (error level analysis, perceptual hash), `exifr` (metadata) | Free, local |
| Routing | OSRM public demo server | Free, no key, fair use (self-host OSRM via `OSRM_URL` if needed) |
| Place search | OpenStreetMap Nominatim | Free, no key, 1 request/second (the code throttles and caches) |

When the LLM is unavailable (no key, free quota used, provider rate-limited), every feature still works: Ask BAT switches to a rule-based planner and the digest uses a data-generated template.

The BAT News Agent and Import from X (`server/agent/`) use the same free budget: the agent takes at most `AGENT_DAILY_AI_BUDGET` calls a day (default 20) and never starts an AI step when fewer than 10 site-wide calls are left. See `server/agent/README.md`.

## Settings (`server/.env`, all optional)

```
OPENROUTER_API_KEY=...            # already used by the project
OPENROUTER_AGENT_MODELS=a:free,b:free   # override the free model chain
AI_DAILY_LLM_BUDGET=45            # stop calling the LLM after this many calls/day
AI_REASONING_EFFORT=low           # OpenRouter reasoning effort for "thinking" models (off = don't send)
AI_DISABLE_LLM=true               # force offline mode
AI_DISABLE_LOCAL_MODELS=true      # skip MiniLM + image detector (uses TF-IDF fallback)
AI_PREWARM=false                  # don't download/load local models at startup
AI_IMAGE_DETECTOR_MODEL=...       # swap the ONNX detector
OSRM_URL=http://localhost:5000    # self-hosted OSRM
IMAGE_FETCH_ALLOWED_HOSTS=...     # extra hosts allowed for proof-photo downloads
ALLOW_PAID_MODELS=true            # never set this unless the project gets funding
```

Caches (downloaded models, digests, integrity results) live in `server/.cache/` (git-ignored).
Optional: run the new section at the end of `Database/schema.sql` to also store integrity results in the `accidents` table.

## API

| Method | Path | Notes |
|---|---|---|
| POST | `/api/ask` | `{ "question": "..." }`, 20 per 15 min per IP |
| GET | `/api/risk/grid?minLevel=medium&hour=` | GeoJSON cells + model card |
| GET | `/api/risk/model` | Coefficients and validation metrics |
| GET | `/api/risk/point?lat=&lng=` | Risk at a point |
| GET | `/api/routes/safe?from=&to=` | Place names or `lat,lng`, 30 per 15 min per IP |
| GET | `/api/digest?period=week\|month` | Grounded digest |
| GET | `/api/ai/status` | Which models and services are active, remaining free calls |
| GET | `/api/admin/integrity?ids=a,b` | Admin: verdict summaries |
| GET | `/api/admin/integrity/:id` | Admin: full report (computes if missing) |
| POST | `/api/admin/integrity/:id/check?deep=1` | Admin: re-run; `deep` adds the free vision-LLM check |
| POST | `/api/admin/integrity/image-test` | Admin: raw image body, any photo |
| POST | `/api/admin/risk/retrain`, `/api/admin/digest/refresh` | Admin |

New citizen reports are screened automatically in the background after `POST /api/reports`.
Report time of day (`time` field) is now stored in `date_raw` so hour-based analytics start filling in.

## How each piece stays honest

- **Agent safety.** The LLM never writes SQL. It can only call 8 fixed tools, and every argument is validated and clamped. Charts come from tool output only. Any number in the answer that isn't in the tool results causes a data-generated answer to be shown instead.
- **Digest grounding.** Numbers are checked against the computed facts. Severity claims are checked separately, because "11 lives lost" when 6 were fatal uses a real number in the wrong place. A failed check falls back to the template.
- **Missing data is stated.** No record has a time of day yet, so "after 10pm" questions say so and show all-hours results rather than an empty answer.
- **Forensics are decision support.** Moderators see the signals and an error-level-analysis map; nothing is auto-rejected.

## Model results on the current data (727 incidents)

- Risk model, 5-fold cross-validation: the top 10% of grid cells captured about 95% of held-out incidents (PAI ≈ 9.5).
- Temporal backtest: trained only on incidents before June 2025, the top 10% of cells captured 90% of the 31 later incidents.
- Honest caveat: the naive "rank by past count" baseline scores the same. The 727 incidents sit on only about 127 distinct coordinates, because most news reports are geocoded to area centres. More precise locations from citizen reports are what will let the neighbourhood and road-type features add lift.
- Gibberish detector: 0 false positives on 1,408 real titles.
- AI-image detector: correct on 3 real accident photos and 1 AI image at original resolution. It is unreliable on images already shrunk below about 600 px, so it is down-weighted there.

## Tests

```
npm --prefix server run test:ai      # 66 tests, offline (LLM, network and model downloads mocked or disabled)
npm --prefix server test             # whole server suite
```
