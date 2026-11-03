# odds-api

Independent football win-probability API. Step 1: basic server, deploy-ready.

## What this does right now
- `GET /` — health check, confirms the server is alive
- `GET /v1/ping` — placeholder, proves routing works

Nothing real yet — no data, no predictions. This step only proves the
server runs locally and can be deployed. Steps 2+ add the database,
the data-fetch job from football-data.org, your prediction logic, and
API key access.

## Run it locally
```
npm install
npm start
```
Then visit http://localhost:3000 — you should see a JSON status message.

## Deploy to Render (free)
1. Push this folder to a GitHub repo (can be private).
2. Go to render.com, sign up free, click "New +" → "Web Service".
3. Connect your GitHub repo.
4. Settings:
   - Build Command: `npm install`
   - Start Command: `npm start`
5. Click deploy. Render gives you a live URL like
   `https://odds-api-xxxx.onrender.com` — that's your API, live on the internet.
6. Visit `https://your-url.onrender.com/` to confirm it's live.

Free tier note: Render's free service sleeps after ~15 min of no traffic,
and takes a few seconds to wake on the next request. Fine for now —
we'll deal with that later if it becomes a real problem.

## Next steps (in order)
1. ✅ Basic server (this step)
2. Supabase database — store fixtures/results so we're not hitting
   football-data.org on every request
3. Scheduled fetch job — pulls data from football-data.org into Supabase
   every few hours
4. `/v1/predict` endpoint — your actual win-probability logic, reading
   from Supabase
5. API key auth — track usage, separate your unlimited access from
   future paid tiers
6. Connect your existing HTML/JS site to call this API instead of
   calculating in-browser
