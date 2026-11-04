# Repo Dashboard

One page with the status and traffic of every public repo on `mediavanity-dev`, at **https://mediavanity-dev.github.io/dashboard/**.

## Where things are

| What | Where |
|---|---|
| Code (local) | `C:\Users\media\Desktop\dans stuff\Development\Dashboard` |
| Code (GitHub) | https://github.com/mediavanity-dev/dashboard (public, account `mediavanity-dev`) |
| Hosting | GitHub Pages, deployed by GitHub Actions |

## What it shows

| Section | Source |
|---|---|
| Status: each repo's site (live check + response time), Pages build, every workflow's latest run, stars, issues, last push | GitHub API |
| Site visitors: visitors per day per site, top pages, sources, countries, devices | Google Analytics 4 (once connected, see below) |
| GitHub repo traffic: views, unique visitors and clones per day on github.com | GitHub traffic API |
| Where repo visitors come from: top referrers and pages, last 14 days | GitHub traffic API |

GitHub only keeps 14 days of traffic. Each run folds that window into `site/data/history.json`, so the charts keep growing from the first run on (2026-10-22).

Repo traffic is visits to the repos on github.com. GitHub doesn't count visits to the sites themselves, and GoDaddy can't either (it only provides DNS for the custom domains; visitors never reach GoDaddy). That's what Google Analytics is for.

Private repos are left out because the page is public. Set `INCLUDE_PRIVATE: '1'` in the workflow to include them.

## How it works

| File | Purpose |
|---|---|
| `collect.mjs` | Fetches everything and writes `site/data/latest.json` and `site/data/history.json` (Node, no dependencies) |
| `site/index.html` | The whole page (HTML, CSS and JS in one file; charts are plain SVG) |
| `.github/workflows/update.yml` | Runs the collector every 6 hours, commits the data, deploys |

Run locally: `GH_TOKEN=$(gh auth token) node collect.mjs`, then serve `site/` with any static server.

## Secrets (repo Settings → Secrets and variables → Actions)

| Secret | Needed for | Value |
|---|---|---|
| `DASHBOARD_TOKEN` | Everything | Fine-grained token, see below |
| `GA4_PROPERTY_ID` | Site visitors | The GA4 property's numeric id |
| `GA4_CREDENTIALS` | Site visitors | The whole service-account JSON key file |

### DASHBOARD_TOKEN

The workflow's built-in token can't read other repos' traffic, so it needs its own.
GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token:

- Repository access: **All repositories** (new repos then show up automatically)
- Permissions, all **Read-only**: Actions, Administration (needed for traffic), Metadata, Pages
- Expiration: up to a year. When it expires, the scheduled runs fail and GitHub emails you; make a new one and replace the secret.

## Connecting Google Analytics

1. **Make the property.** https://analytics.google.com → Admin → Create → Property (one property for all sites). Add a **Web** data stream for `dailygeographer.com`. Copy its Measurement ID (`G-XXXXXXXXXX`). The same tag goes on every site; the dashboard separates them by domain and path.
2. **Tag the sites.** Put the Google tag in the `<head>` of each site (dailygeographer, dailyditch, standards, alchemy, chordshapes, fretboard, timesbane).
3. **Let the dashboard read it.** In https://console.cloud.google.com: create a project, enable the **Google Analytics Data API**, create a **service account**, and add a JSON key (downloads a file). Then in Analytics → Admin → Property access management, add the service account's email as **Viewer**.
4. **Add the secrets** `GA4_PROPERTY_ID` (Admin → Property details) and `GA4_CREDENTIALS` (paste the JSON file's contents), then run the workflow (Actions → Update and deploy → Run workflow).

GA4 sets cookies. If you get visitors from the EU/UK, a cookie notice is expected.
