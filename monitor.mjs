/**
 * Autonomous Sacred Cube Loadboard Monitor — Railway Edition
 * ----------------------------------------------------------
 * Runs as a standalone Railway service. Every 2 minutes:
 * 1. Logs into Sacred Cube via Pakistan proxy (IPRoyal)
 * 2. Searches loadboard for SB loads from TN
 * 3. Deduplicates by postingId against Railway Postgres
 * 4. INSERTs new loads INSTANTLY into TRAQ IQ loads table
 * 5. Syncs to Google Sheet (optional)
 * 6. Daily sheet refresh at midnight — clears and starts fresh
 */

import axios from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as cheerio from 'cheerio';
import pg from 'pg';
const { Client } = pg;

// ─── CONFIG (all from env vars) ────────────────────────────────────────
const CONFIG = {
  // Sacred Cube
  loginUrl: 'https://access-control.sacredcube.co/login',
  tmsBase: 'https://tms.sacredcube.co',
  loadboardApi: 'https://tms.sacredcube.co/nova-vendor/loadboard/loadsAggregate',
  email: process.env.SC_EMAIL || 'annex561@gmail.com',
  password: process.env.SC_PASSWORD,

  // Pakistan Proxy
  proxyHost: process.env.PROXY_HOST || 'geo.iproyal.com',
  proxyPort: process.env.PROXY_PORT || '12321',
  proxyUser: process.env.PROXY_USER,
  proxyPass: process.env.PROXY_PASS,

  // Database
  databaseUrl: process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL,

  // Google Sheet (optional)
  sheetId: '1AQ-vAhewUVmE-86Z3D_M3KYJg3lzvK5Q-w1horGrgI4',
  googleServiceAccountKey: process.env.GOOGLE_SERVICE_ACCOUNT_KEY,

  // Search
  origin: process.env.SEARCH_ORIGIN || 'TN',
  equipmentTypes: (process.env.EQUIPMENT_TYPES || 'SB').split(','),
  dhOrigin: parseInt(process.env.DH_ORIGIN || '150'),
  dhDest: parseInt(process.env.DH_DEST || '150'),

  // Timing
  intervalMs: parseInt(process.env.INTERVAL_MS || '120000'),
  sessionRefreshMs: parseInt(process.env.SESSION_REFRESH_MS || '1800000'),
};

// ─── GLOBALS ─────────────────────────────────────────────────
let csrfToken = null;
let httpClient = null;
let lastLoginTime = 0;
let checkCount = 0;
let totalInserted = 0;

// ─── PROXY ───────────────────────────────────────────────────
function getProxyAgent() {
  if (!CONFIG.proxyUser || !CONFIG.proxyPass) {
    console.warn('No proxy credentials — requests go direct');
    return undefined;
  }
  const proxyUrl = `http://${encodeURIComponent(CONFIG.proxyUser)}:${encodeURIComponent(CONFIG.proxyPass)}@${CONFIG.proxyHost}:${CONFIG.proxyPort}`;
  return new HttpsProxyAgent(proxyUrl);
}

// ─── LOGIN ───────────────────────────────────────────────────
async function login() {
  console.log('Logging into Sacred Cube...');
  const jar = new CookieJar();
  const agent = getProxyAgent();

  const axiosConfig = {
    jar,
    withCredentials: true,
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    },
    timeout: 30000,
  };

  httpClient = wrapper(axios.create(axiosConfig));

  // Step 1: GET login page
  const loginPage = await httpClient.get(CONFIG.loginUrl);
  const $ = cheerio.load(loginPage.data);
  csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();
  if (!csrfToken) throw new Error('No CSRF token on login page');

  // Step 2: POST credentials
  await httpClient.post(CONFIG.loginUrl, new URLSearchParams({
    _token: csrfToken,
    email: CONFIG.email,
    password: CONFIG.password,
  }).toString(), {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-CSRF-TOKEN': csrfToken,
      'Referer': CONFIG.loginUrl,
    },
    maxRedirects: 5,
  });

  // Step 3: Visit TMS loadboard via proxy
  const proxyConfig = agent ? { httpsAgent: agent, httpAgent: agent } : {};
  const tmsPage = await httpClient.get(`${CONFIG.tmsBase}/loadboard/turbo`, {
    ...proxyConfig,
    headers: { 'Accept': 'text/html', 'Referer': CONFIG.loginUrl },
  });

  const $tms = cheerio.load(tmsPage.data);
  const tmsCsrf = $tms('meta[name="csrf-token"]').attr('content');
  if (tmsCsrf) csrfToken = tmsCsrf;

  // Extract user/tenant from Inertia page props
  const pageMatch = tmsPage.data.match(/data-page="([^"]+)"/);
  if (pageMatch) {
    try {
      const pd = JSON.parse(pageMatch[1].replace(/&quot;/g, '"'));
      if (pd.props?.currentUser) CONFIG._user = pd.props.currentUser;
      if (pd.props?.currentTenant) CONFIG._tenant = pd.props.currentTenant;
    } catch {}
  }

  lastLoginTime = Date.now();
  console.log('  Login OK');
}

// ─── SEARCH ──────────────────────────────────────────────────
function buildPayload() {
  const today = new Date();
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const fmt = d => d.toISOString().split('T')[0];

  return {
    origin: CONFIG.origin, 'dh-o': CONFIG.dhOrigin,
    dest: '', 'dh-d': CONFIG.dhDest,
    length: null, weight: null, 'full-partial': 'both',
    'look-in-time': 24,
    'start-date': fmt(today), 'end-date': fmt(tomorrow),
    sortOption: 'Age', sortDirection: 'Ascending',
    loadboards: ['ALL'],
    user: CONFIG._user || {
      id: 1, global_id: '8f2370df-b4f5-47f9-96d4-0d58adeec120',
      name: 'Alex cius', email: 'annex561@gmail.com',
      active: true, external: false, blocked: false,
      canImpersonate: true, impersonating: false,
    },
    tenant: CONFIG._tenant || { id: 5297, title: 'Lamp', hasTrial: false, isTrialExpired: false, trialExpiryWarning: null },
    searchDetails: {
      DAT: { id: 'MTY0', queryId: '9_7B5NyOsv7Y2F-DCqcbkcIpbwVxIxdOLWMhUU3ieio' },
      '123LOADBOARD': {}, TRUCKSTOP: { queryId: null }, TRUCKERPATH: {}, SYLECTUS: { queryId: null },
    },
    etypes: CONFIG.equipmentTypes,
  };
}

async function searchLoadboard() {
  const agent = getProxyAgent();
  const proxyConfig = agent ? { httpsAgent: agent, httpAgent: agent } : {};

  const res = await httpClient.post(CONFIG.loadboardApi, buildPayload(), {
    ...proxyConfig,
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-CSRF-TOKEN': csrfToken,
      'X-Requested-With': 'XMLHttpRequest',
      'Referer': `${CONFIG.tmsBase}/loadboard/turbo`,
    },
  });
  return res.data;
}

// ─── EXTRACT ─────────────────────────────────────────────────
function extractLoads(response) {
  const loads = [];
  for (const src of ['DAT', 'TRUCKSTOP', 'SYLECTUS', '123LOADBOARD', 'DOFT', 'TRUCKERPATH']) {
    const s = response[src];
    if (!s || s.offline) continue;
    for (const key of ['matchingLoads', 'similarLoads']) {
      if (Array.isArray(s[key])) s[key].forEach(l => loads.push({ ...l, _source: src }));
    }
  }
  return loads;
}

// ─── DATABASE INSERT + DEDUP ───────────────────────────────────
async function insertNewLoads(loads) {
  if (!CONFIG.databaseUrl) {
    console.warn('  No DATABASE_URL — skipping DB insert');
    return [];
  }

  const db = new Client({ connectionString: CONFIG.databaseUrl, ssl: CONFIG.databaseUrl.includes('railway.internal') ? false : { rejectUnauthorized: false } });
  await db.connect();

  try {
    const existing = await db.query("SELECT description FROM loads WHERE description LIKE 'SC:%'");
    const seenIds = new Set(existing.rows.map(r => r.description));

    const newLoads = [];
    for (const l of loads) {
      const pid = l.postingId || l.resultId || `${l.origin}-${l.destination}-${l.offer}-${l.company}`;
      const descKey = `SC:${pid}`;
      if (seenIds.has(descKey)) continue;
      seenIds.add(descKey);

      const originParts = (l.origin || '').split(',').map(s => s.trim());
      const destParts = (l.destination || '').split(',').map(s => s.trim());

      try {
        await db.query(
          `INSERT INTO loads (company_id, load_number, description, priority, pickup_address, pickup_date,
           delivery_address, status, load_type, equipment_type, miles, weight, company, contact_phone,
           broker_name, broker_email, source_board, lifecycle_status, origin_city, origin_state,
           dest_city, dest_state, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,NOW(),NOW())`,
          [
            1, `LB-${pid.slice(0, 12)}`, descKey,
            l.offer ? 'high' : 'medium',
            l.origin || '', l.pickUpDate || new Date().toISOString().split('T')[0],
            l.destination || '', 'available',
            l.fullPartial || 'FTL', l.equipmentTypeCode || 'SB',
            l.tripMiles || null, l.weight || null,
            l.company || '', l.phone || '',
            l.company || '', l.email || '',
            l._source || 'DAT', 'new',
            originParts[0] || '', originParts[1] || CONFIG.origin,
            destParts[0] || '', destParts[1] || '',
          ]
        );
        newLoads.push(l);
      } catch (e) {
        if (!e.message.includes('duplicate')) console.error(`  Insert err: ${e.message}`);
      }
    }
    return newLoads;
  } finally {
    await db.end();
  }
}

// ─── MAIN CHECK ──────────────────────────────────────────────
async function runCheck() {
  try {
    if (Date.now() - lastLoginTime > CONFIG.sessionRefreshMs) {
      await login();
    }

    checkCount++;
    const ts = new Date().toLocaleTimeString();
    process.stdout.write(`[${ts}] #${checkCount} Searching... `);

    const response = await searchLoadboard();
    const allLoads = extractLoads(response);
    const newLoads = await insertNewLoads(allLoads);

    totalInserted += newLoads.length;
    console.log(`${allLoads.length} total, ${newLoads.length} new (${totalInserted} total inserted)`);

    if (newLoads.length > 0) {
      console.log(`  NEW LOADS:`);
      newLoads.sort((a, b) => (b.offer || 0) - (a.offer || 0));
      newLoads.slice(0, 5).forEach(l => {
        const rpm = l.offer && l.tripMiles ? `$${(l.offer / l.tripMiles).toFixed(2)}/mi` : '';
        console.log(`    $${l.offer || '?'} | ${l.origin} -> ${l.destination} | ${l.tripMiles || '?'}mi ${rpm} | ${l.company || ''} | ${l.phone || ''}`);
      });
    }
  } catch (err) {
    console.error(`Check failed: ${err.message}`);
    if (err.response?.status === 401 || err.response?.status === 419) {
      lastLoginTime = 0;
    }
  }
}

// ─── START ───────────────────────────────────────────────────
async function main() {
  console.log('Sacred Cube Loadboard Monitor v2.0');
  console.log(`Origin: ${CONFIG.origin} | Equipment: ${CONFIG.equipmentTypes.join(',')}`);
  console.log(`Interval: ${CONFIG.intervalMs / 1000}s | DB: ${CONFIG.databaseUrl ? 'YES' : 'NO'}`);

  if (!CONFIG.password) {
    console.error('SC_PASSWORD required'); process.exit(1);
  }

  await login();
  await runCheck();

  setInterval(runCheck, CONFIG.intervalMs);
  console.log(`Running every ${CONFIG.intervalMs / 1000}s. Ctrl+C to stop.`);
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
