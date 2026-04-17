# openrun.peck.to

FastHTML case-study + submission page for the Open Run Agentic Pay
hackathon (April 2026). Single page. Every claim resolves to a URL or
a txid.

## Layout

- `app.py` — FastHTML layout, one route `/`
- `content.py` — all copy + stats + txids + links
- `static/openrun.css` — page-level styling on top of peck-ui tokens
- `Dockerfile` + `cloudbuild.yaml` — Cloud Run deploy from the
  `peck-to/` workspace root
- peck-ui is installed editable during dev; Cloud Run build COPYs it
  from the sibling repo

## Local dev

```bash
cd peck-mcp/openrun
python3 -m venv .venv
.venv/bin/pip install --upgrade pip < /dev/null
.venv/bin/pip install -e ../../peck-ui < /dev/null
.venv/bin/pip install -r requirements.txt < /dev/null
.venv/bin/python app.py < /dev/null
# open http://localhost:8080
```

## Editing

- Copy, stats, txids, repos, upstream list → `content.py`
- Layout, section order, components → `app.py`
- Typography, spacing, table and timeline styling → `static/openrun.css`

peck-ui components in use: `container`, `stack`, `row`, `grid`, `card`,
`badge`, `button`, `heading`, `text`, `code`, `peck_icon`, `peck_head`,
`peck_app`. Anything visual that is not a peck-ui component lives in
`openrun.css`.

## Deploy to Cloud Run

From the workspace root (`/home/thomas/Documents/peck-to/`):

```bash
gcloud builds submit \
  --project gen-lang-client-0447933194 \
  --config peck-mcp/openrun/cloudbuild.yaml .
```

Then map the domain:

```bash
gcloud beta run domain-mappings create \
  --service=openrun \
  --region=europe-west1 \
  --domain=openrun.peck.to
```

## Keeping numbers honest

`content.STATS` and `content.ONCHAIN_PROOF` are hand-edited. Before
submission, pull latest from:

- `overlay.peck.to/v1/stats` for post counts
- `whatsonchain.com` for each txid in the proof table
- latest burst txids from the mainnet run on April 15

If you change a number here, leave a git commit explaining where it
came from. The whole point of the page is that every claim is
verifiable.
