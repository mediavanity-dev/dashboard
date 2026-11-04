// Collects repo, Pages, Actions and traffic data for every repo the token's owner owns,
// plus Google Analytics 4 site traffic when GA4 credentials are set. Writes site/data/*.json.
// Run by GitHub Actions; needs Node 20+ (built-in fetch). No dependencies.
//
// Env:
//   GH_TOKEN          token that can read traffic (fine-grained: Administration, Pages, Actions, Metadata: read)
//   INCLUDE_PRIVATE   "1" to include private repos (the published page is public, so off by default)
//   GA4_PROPERTY_ID   numeric GA4 property id (optional)
//   GA4_CREDENTIALS   service-account JSON key with Viewer access to that property (optional)
import { createSign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const DATA_DIR = new URL('./site/data/', import.meta.url);
const HISTORY_FILE = new URL('history.json', DATA_DIR);
const { GH_TOKEN, INCLUDE_PRIVATE, GA4_PROPERTY_ID, GA4_CREDENTIALS } = process.env;
if (!GH_TOKEN) throw new Error('GH_TOKEN is not set.');

const GH_HEADERS = {
  Authorization: `Bearer ${GH_TOKEN}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'repo-dashboard',
};

// Returns parsed JSON, or null for 404 (e.g. a repo without Pages).
async function gh(path) {
  const res = await fetch(`https://api.github.com${path}`, { headers: GH_HEADERS, signal: AbortSignal.timeout(30000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GET ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.json();
}

// Is the site actually answering? Records HTTP status and response time.
async function probe(url) {
  const start = Date.now();
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(20000) });
    return { ok: res.ok, status: res.status, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, status: null, ms: null, error: err.message };
  }
}

const day = (ts) => ts.slice(0, 10);

async function collectRepo(r) {
  const full = r.full_name;
  const [pages, workflows, views, clones, referrers, paths] = await Promise.all([
    gh(`/repos/${full}/pages`),
    gh(`/repos/${full}/actions/workflows?per_page=100`),
    gh(`/repos/${full}/traffic/views?per=day`),
    gh(`/repos/${full}/traffic/clones?per=day`),
    gh(`/repos/${full}/traffic/popular/referrers`),
    gh(`/repos/${full}/traffic/popular/paths`),
  ]);

  let site = null;
  if (pages) {
    // Legacy (branch) builds report their own status; workflow builds are covered by the workflow runs below.
    const build = pages.build_type === 'legacy' ? await gh(`/repos/${full}/pages/builds/latest`) : null;
    site = {
      url: pages.html_url,
      domain: pages.cname,
      https: pages.https_enforced,
      buildType: pages.build_type,
      buildStatus: build?.status ?? null,
      builtAt: build?.updated_at ?? null,
      probe: await probe(pages.html_url),
    };
  }

  const runs = await Promise.all((workflows?.workflows ?? []).map(async (w) => {
    const run = (await gh(`/repos/${full}/actions/workflows/${w.id}/runs?per_page=1`))?.workflow_runs?.[0];
    return {
      name: w.name,
      state: w.state,
      url: w.html_url,
      run: run && {
        status: run.status,          // queued | in_progress | completed
        conclusion: run.conclusion,  // success | failure | cancelled | skipped | null
        event: run.event,
        at: run.run_started_at ?? run.created_at,
        url: run.html_url,
      },
    };
  }));

  return {
    repo: {
      name: r.name,
      url: r.html_url,
      description: r.description,
      private: r.private,
      language: r.language,
      stars: r.stargazers_count,
      forks: r.forks_count,
      watchers: r.subscribers_count ?? r.watchers_count,
      openIssues: r.open_issues_count,
      pushedAt: r.pushed_at,
      createdAt: r.created_at,
      sizeKB: r.size,
    },
    site,
    workflows: runs,
    traffic: {
      views: (views?.views ?? []).map((v) => ({ date: day(v.timestamp), count: v.count, uniques: v.uniques })),
      clones: (clones?.clones ?? []).map((c) => ({ date: day(c.timestamp), count: c.count, uniques: c.uniques })),
      referrers: referrers ?? [],
      paths: (paths ?? []).map((p) => ({ path: p.path, count: p.count, uniques: p.uniques })),
    },
  };
}

// GitHub only keeps 14 days of traffic, so each run folds the window into a permanent history.
// Days inside the window are overwritten (the latest fetch is authoritative); older days are kept.
function mergeHistory(history, results) {
  for (const { repo, traffic } of results) {
    const h = (history[repo.name] ??= {});
    for (const v of traffic.views) (h[v.date] ??= {}).views = v.count, h[v.date].viewUniques = v.uniques;
    for (const c of traffic.clones) (h[c.date] ??= {}).clones = c.count, h[c.date].cloneUniques = c.uniques;
  }
  return history;
}

// --- Google Analytics 4 (Data API, service-account auth) ---

async function googleToken(creds) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const sig = createSign('RSA-SHA256').update(unsigned).sign(creds.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${sig}` }),
  });
  if (!res.ok) throw new Error(`Google token: HTTP ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function gaReport(token, body) {
  const res = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY_ID}:runReport`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ dateRanges: [{ startDate: '90daysAgo', endDate: 'today' }], limit: 10000, ...body }),
  });
  if (!res.ok) throw new Error(`GA4 report: HTTP ${res.status} ${await res.text()}`);
  const { dimensionHeaders = [], metricHeaders = [], rows = [] } = await res.json();
  return rows.map((row) => Object.fromEntries([
    ...row.dimensionValues.map((d, i) => [dimensionHeaders[i].name, d.value]),
    ...row.metricValues.map((m, i) => [metricHeaders[i].name, Number(m.value)]),
  ]));
}

// One GA4 tag is shared by every site; hostname (plus the first path segment on *.github.io) tells them apart.
function siteKey(host, path, sites) {
  const seg = path.split('/')[1] ?? '';
  const match = sites.find((s) => {
    const u = new URL(s.url);
    return u.hostname === host && (u.pathname === '/' || u.pathname.split('/')[1] === seg);
  });
  return match?.repo ?? host;
}

async function collectGA(sites) {
  if (!GA4_PROPERTY_ID || !GA4_CREDENTIALS) return null;
  const token = await googleToken(JSON.parse(GA4_CREDENTIALS));
  const metrics = ['activeUsers', 'sessions', 'screenPageViews'].map((name) => ({ name }));
  const [daily, pages, sources, countries, devices] = await Promise.all([
    gaReport(token, { dimensions: [{ name: 'date' }, { name: 'hostName' }, { name: 'landingPage' }], metrics }),
    gaReport(token, { dimensions: [{ name: 'hostName' }, { name: 'pagePath' }], metrics: [{ name: 'screenPageViews' }, { name: 'activeUsers' }] }),
    gaReport(token, { dimensions: [{ name: 'hostName' }, { name: 'landingPage' }, { name: 'sessionSource' }], metrics: [{ name: 'sessions' }] }),
    gaReport(token, { dimensions: [{ name: 'hostName' }, { name: 'landingPage' }, { name: 'country' }], metrics: [{ name: 'activeUsers' }] }),
    gaReport(token, { dimensions: [{ name: 'hostName' }, { name: 'landingPage' }, { name: 'deviceCategory' }], metrics: [{ name: 'activeUsers' }] }),
  ]);

  const out = {};
  const site = (key) => (out[key] ??= { daily: {}, pages: {}, sources: {}, countries: {}, devices: {} });
  const add = (obj, k, n) => { obj[k] = (obj[k] ?? 0) + n; };
  for (const r of daily) {
    const d = `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6)}`;
    const e = (site(siteKey(r.hostName, r.landingPage, sites)).daily[d] ??= { users: 0, sessions: 0, views: 0 });
    e.users += r.activeUsers; e.sessions += r.sessions; e.views += r.screenPageViews;
  }
  for (const r of pages) add(site(siteKey(r.hostName, r.pagePath, sites)).pages, r.pagePath, r.screenPageViews);
  for (const r of sources) add(site(siteKey(r.hostName, r.landingPage, sites)).sources, r.sessionSource, r.sessions);
  for (const r of countries) add(site(siteKey(r.hostName, r.landingPage, sites)).countries, r.country, r.activeUsers);
  for (const r of devices) add(site(siteKey(r.hostName, r.landingPage, sites)).devices, r.deviceCategory, r.activeUsers);

  // Keep the top entries only; the page shows top 8.
  const top = (obj, n = 15) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, count]) => ({ name, count }));
  for (const s of Object.values(out)) for (const k of ['pages', 'sources', 'countries', 'devices']) s[k] = top(s[k]);
  return out;
}

// --- main ---

const owner = await gh('/user');
let repos = [];
for (let page = 1; ; page++) {
  const batch = await gh(`/user/repos?affiliation=owner&per_page=100&page=${page}`);
  repos.push(...batch);
  if (batch.length < 100) break;
}
repos = repos.filter((r) => !r.archived && (INCLUDE_PRIVATE === '1' || !r.private));

const results = [];
for (const r of repos) results.push(await collectRepo(r)); // sequential: friendlier to the secondary rate limit
results.sort((a, b) => b.repo.pushedAt.localeCompare(a.repo.pushedAt));

const sites = results.filter((x) => x.site).map((x) => ({ repo: x.repo.name, url: x.site.url }));
let analytics = null;
try {
  analytics = await collectGA(sites);
} catch (err) {
  // A GA failure shouldn't stop the GitHub half from updating.
  console.error(err.message);
  analytics = { error: err.message };
}

await mkdir(DATA_DIR, { recursive: true });
const history = mergeHistory(JSON.parse(await readFile(HISTORY_FILE, 'utf8').catch(() => '{}')), results);
await writeFile(HISTORY_FILE, JSON.stringify(history, null, 1));
await writeFile(new URL('latest.json', DATA_DIR), JSON.stringify({
  generatedAt: new Date().toISOString(),
  owner: { login: owner.login, url: owner.html_url, avatar: owner.avatar_url },
  repos: results,
  analytics,
}, null, 1));

console.log(`${results.length} repos, ${sites.length} sites${analytics && !analytics.error ? ', GA4 included' : ''}.`);
