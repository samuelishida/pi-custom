# web-search

`web_search` tool backed by Google Custom Search JSON API.

## Setup (required)

`web_search` needs Google credentials. Without them the tool returns:

```
Missing Google Custom Search credentials. Set GOOGLE_SEARCH_API_KEY and
GOOGLE_CSE_ID, or create auth.json from auth.example.json.
```

Two ways to configure:

1. **auth.json** (recommended): copy `auth.example.json` to `auth.json` in this
   directory and fill in your keys:

   ```json
   {
     "google_search_api_key": "YOUR_GOOGLE_CUSTOM_SEARCH_API_KEY",
     "google_cse_id": "YOUR_GOOGLE_CUSTOM_SEARCH_ENGINE_ID"
   }
   ```

   Get credentials from https://developers.google.com/custom-search/v1/introduction

2. **Environment variables**: export `GOOGLE_SEARCH_API_KEY` and
   `GOOGLE_CSE_ID` in your shell before starting pi.

## Degraded mode

When `web_search` is unavailable, workflows fall back to `web_fetch` on known
URLs (repos, docs, search-engine result pages) and record the capability as
blocked in their provenance. The bundled `deepresearch` and `autoresearch`
prompt templates already handle this.
