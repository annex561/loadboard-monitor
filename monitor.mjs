import { HttpsProxyAgent } from 'https-proxy-agent';
import * as cheerio from 'cheerio';
import pg from 'pg';
import net from 'net';
import fetch from 'node-fetch';
const { Client } = pg;

// ââ Config ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
const CONFIG = {
  scEmail:    process.env.SC_EMAIL    || 'annex561@gmail.com',
  scPassword: process.env.SC_PASSWORD || '',
  proxyHost:  process.env.PROXY_HOST  || 'geo.iproyal.com',
  proxyPort:  process.env.PROXY_PORT  || '12321',
  proxyUser:  process.env.PROXY_USER  || '',
  proxyPass:  process.env.PROXY_PASS  || '',
  dbUrl:      process.env.DATABASE_PUBLIC_URL || '',
  interval:   2 * 60 * 1000, // 2 minutes
};

let sessionCookies = '';
let csrfToken = '';

// ââ Singleton proxy agent âââââââââââââââââââââââââââââââââââââââââââââââ
let _proxyAgent = null;
function getProxyAgent() {
  if (_proxyAgent) return _proxyAgent;
  const encodedUser = encodeURIComponent(CONFIG.proxyUser);
  const encodedPass = encodeURIComponent(CONFIG.proxyPass);
  const proxyUrl = `http://${encodedUser}:${encodedPass}@${CONFIG.proxyHost}:${CONFIG.proxyPort}`;
  console.log(`  Proxy URL: http://${encodedUser}:${encodedPass.substring(0,10)}****@${CONFIG.proxyHost}:${CONFIG.proxyPort}`);
  console.log(`  Raw password: ${CONFIG.proxyPass}`);
  console.log(`  Encoded password: ${encodedPass}`);
  _proxyAgent = new HttpsProxyAgent(proxyUrl);
  return _proxyAgent;
}

// ââ Raw TCP connectivity test âââââââââââââââââââââââââââââââââââââââââââ
function testTcpConnect(host, port, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', (err) => { sock.destroy(); console.error(`  TCP error: ${err.message}`); resolve(false); });
    sock.on('timeout', () => { sock.destroy(); console.error('  TCP timeout'); resolve(false); });
    sock.connect(port, host);
  });
}

// ââ Test proxy connectivity âââââââââââââââââââââââââââââââââââââââââââââ
async function testProxy() {
  console.log('\n=== PROXY CONNECTIVITY TEST ===');

  // Step 0: raw TCP check
  console.log(`  Testing TCP to ${CONFIG.proxyHost}:${CONFIG.proxyPort}...`);
  const tcpOk = await testTcpConnect(CONFIG.proxyHost, parseInt(CONFIG.proxyPort));
  console.log(`  TCP connect: ${tcpOk ? 'OK' : 'FAILED'}`);
  if (!tcpOk) return false;

  // Step 1: proxy fetch through https-proxy-agent
  const agent = getProxyAgent();
  try {
    const res = await fetch('https://ipv4.icanhazip.com', {
      agent,
      signal: AbortSignal.timeout(15000),
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const body = await res.text();
    console.log(`  Status: ${res.status}`);
    if (res.status === 407) {
      console.error(`  PROXY AUTH REJECTED (407)`);
      console.error(`  Response body: ${body.substring(0, 500)}`);
      console.error(`  Response headers: ${JSON.stringify(Object.fromEntries(res.headers.entries()))}`);
      return false;
    }
    if (res.status >= 400) {
      console.error(`  Proxy returned error status ${res.status}: ${body.substring(0, 200)}`);
      return false;
    }
    console.log(`  IP:     ${body.trim()}`);
    console.log('  Proxy is WORKING');
    return true;
  } catch (err) {
    console.error(`  Proxy test FAILED: ${err.message}`);
    if (err.cause) console.error(`  Cause: ${err.cause.message || JSON.stringify(err.cause)}`);
    if (err.cause?.cause) console.error(`  Root cause: ${err.cause.cause.message}`);
    console.error(`  Stack: ${err.stack}`);
    return false;
  }
}

// ââ Cookie helper âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function extractCookies(headers) {
  const raw = headers.raw ? headers.raw()['set-cookie'] : [];
  if (!raw || !raw.length) return '';
  return raw.map(c => c.split(';')[0]).join('; ');
}

function mergeCookies(existing, incoming) {
  if (!incoming) return existing;
  const map = {};
  (existing || '').split('; ').filter(Boolean).forEach(c => {
    const [k] = c.split('=');
    map[k] = c;
  });
  incoming.split('; ').filter(Boolean).forEach(c => {
    const [k] = c.split('=');
    map[k] = c;
  });
  return Object.values(map).join('; ');
}

// ââ Fetch helper with proxy ââââââââââââââââââââââââââââââââââââââââââââ
async function proxyFetch(url, options = {}) {
  const agent = getProxyAgent();
  const merged = {
    ...options,
    agent,
    signal: options.signal || AbortSignal.timeout(30000),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(options.headers || {}),
    },
    redirect: options.redirect || 'follow',
  };
  return fetch(url, merged);
}

// ââ Login âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function login() {
  console.log('\n=== LOGIN FLOW ===');

  // Step 1 â GET login page
  console.log('Step 1: GET /login');
  const loginPage = await proxyFetch('https://access-control.sacredcube.co/login');
  console.log(`  Status: ${loginPage.status}`);
  if (loginPage.status === 407) {
    const errBody = await loginPage.text();
    console.error(`  PROXY AUTH FAILED on login page!`);
    console.error(`  407 body: ${errBody.substring(0, 500)}`);
    console.error(`  Headers: ${JSON.stringify(Object.fromEntries(loginPage.headers.entries()))}`);
    throw new Error('Proxy returned 407 - authentication rejected');
  }
  sessionCookies = extractCookies(loginPage.headers);

  const html = await loginPage.text();
  const $ = cheerio.load(html);
  csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();
  console.log(`  CSRF: ${csrfToken ? csrfToken.substring(0, 10) + '...' : 'NOT FOUND'}`);

  // Step 2 â POST login
  console.log('Step 2: POST /login');
  const loginRes = await proxyFetch('https://access-control.sacredcube.co/login', {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Cookie': sessionCookies,
    },
    body: new URLSearchParams({
      _token: csrfToken,
      email: CONFIG.scEmail,
      password: CONFIG.scPassword,
    }).toString(),
  });
  console.log(`  Status: ${loginRes.status}`);
  sessionCookies = mergeCookies(sessionCookies, extractCookies(loginRes.headers));
  // Consume body even if we don't need it (prevents resource leak)
  await loginRes.text();

  // Step 3 â Follow redirect to TMS
  console.log('Step 3: GET /tms (follow redirect)');
  const tmsPage = await proxyFetch('https://access-control.sacredcube.co/tms', {
    headers: { 'Cookie': sessionCookies },
  });
  console.log(`  Status: ${tmsPage.status}`);
  sessionCookies = mergeCookies(sessionCookies, extractCookies(tmsPage.headers));
  const tmsHtml = await tmsPage.text();
  // Re-extract CSRF token from the post-login page (it changes after login)
  const $tms = cheerio.load(tmsHtml);
  const newCsrf = $tms('meta[name="csrf-token"]').attr('content') || $tms('input[name="_token"]').val();
  if (newCsrf) {
    csrfToken = newCsrf;
    console.log(`  Updated CSRF: ${csrfToken.substring(0, 10)}...`);
  } else {
    console.log(`  No new CSRF found in TMS page, keeping original`);
  }
  console.log(`  Cookies: ${sessionCookies.substring(0, 60)}...`);
  console.log('Login complete.');
}

// ââ Search payload ââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function buildPayload() {
  return {
    user: { id: 202, name: "Annex Luberisse" },
    tenant: { id: 5, name: "TRAQ Logistics" },
    etypes: [2, 4],
    searchDetails: {
      origin: { city: "", state: "TN", radius: 200, lat: 35.5175, lng: -86.5804 },
      destination: { city: "", state: "", radius: 200, lat: null, lng: null },
      equipmentTypes: ["SB"],
      pickupDate: new Date().toISOString().split('T')[0],
      minWeight: null, maxWeight: null,
      minRate: null, maxRate: null,
      minMiles: null, maxMiles: null,
      minRPM: null,
      sortBy: "pickupDate", sortDirection: "asc",
      page: 1, perPage: 50,
    },
  };
}

// ââ Loadboard search ââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function searchLoadboard() {
  console.log('\n=== SEARCHING LOADBOARD ===');
  const payload = buildPayload();

  try {
    const res = await proxyFetch(
      'https://access-control.sacredcube.co/nova-vendor/loadboard/loadsAggregate',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cookie': sessionCookies,
          'X-CSRF-TOKEN': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'Referer': 'https://access-control.sacredcube.co/tms',
        },
        body: JSON.stringify(payload),
      }
    );
    console.log(`  Status: ${res.status}`);
    const rawText = await res.text();
    // Check if response is actually JSON
    if (rawText.trim().startsWith('<') || rawText.trim().startsWith('<!')) {
      console.error(`  Search returned HTML instead of JSON!`);
      console.error(`  First 300 chars: ${rawText.substring(0, 300)}`);
      console.error(`  This usually means the session expired or CSRF token is invalid.`);
      // Try to re-login next cycle
      sessionCookies = '';
      csrfToken = '';
      _proxyAgent = null;
      return null;
    }
    const data = JSON.parse(rawText);
    if (Array.isArray(data)) {
      console.log(`  Results: ${data.length} loads`);
    } else if (data && data.data) {
      console.log(`  Results: ${data.data.length} loads (nested)`);
    } else {
      console.log(`  Response keys: ${Object.keys(data || {}).join(', ')}`);
    }
    return data;
  } catch (err) {
    console.error(`  Search FAILED: ${err.message}`);
    return null;
  }
}

// ââ Extract loads âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function extractLoads(apiData) {
  if (!apiData) return [];
  const arr = Array.isArray(apiData) ? apiData : (apiData.data || []);
  return arr.map(l => ({
    postingId:   l.postingId || l.id || '',
    origin:      `${l.originCity || ''}, ${l.originState || ''}`.trim(),
    destination: `${l.destinationCity || ''}, ${l.destinationState || ''}`.trim(),
    pickupDate:  l.pickupDate || '',
    rate:        l.rate || l.ratePerMile || null,
    miles:       l.miles || l.distance || null,
    weight:      l.weight || null,
    equipment:   l.equipmentType || 'SB',
    company:     l.companyName || l.company || '',
    phone:       l.phone || l.contactPhone || '',
    raw:         JSON.stringify(l),
  }));
}

// ââ Insert new loads ââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function insertNewLoads(loads) {
  if (!loads.length) { console.log('No loads to insert.'); return; }
  console.log(`\n=== INSERTING ${loads.length} LOADS ===`);

  const db = new Client({ connectionString: CONFIG.dbUrl });
  await db.connect();

  let inserted = 0, skipped = 0;
  for (const l of loads) {
    const dedupKey = `SC:${l.postingId}`;
    const exists = await db.query(
      `SELECT 1 FROM loads WHERE description = $1 LIMIT 1`, [dedupKey]
    );
    if (exists.rows.length) { skipped++; continue; }

    await db.query(
      `INSERT INTO loads (
        description, origin_city, origin_state, destination_city, destination_state,
        pickup_date, rate, miles, weight, equipment_type, company_name, contact_phone,
        raw_data, source, status, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,NOW(),NOW())`,
      [
        dedupKey,
        l.origin.split(',')[0]?.trim() || '',
        l.origin.split(',')[1]?.trim() || '',
        l.destination.split(',')[0]?.trim() || '',
        l.destination.split(',')[1]?.trim() || '',
        l.pickupDate || null,
        l.rate,
        l.miles,
        l.weight,
        l.equipment,
        l.company,
        l.phone,
        l.raw,
        'sacred_cube',
        'new',
      ]
    );
    inserted++;
  }

  await db.end();
  console.log(`  Inserted: ${inserted}, Skipped (dupes): ${skipped}`);
}

// ââ Run one check âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function runCheck() {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`CHECK @ ${new Date().toISOString()}`);
  console.log('='.repeat(60));

  try {
    await login();
    const data = await searchLoadboard();
    const loads = extractLoads(data);
    console.log(`Extracted ${loads.length} loads`);
    if (loads.length) await insertNewLoads(loads);
  } catch (err) {
    console.error(`\nFATAL ERROR: ${err.message}`);
    console.error(err.stack);
  }
}

// ââ Main ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function main() {
  console.log('Loadboard Monitor v2.8 starting...');
  console.log(`Email: ${CONFIG.scEmail}`);
  console.log(`Proxy: ${CONFIG.proxyHost}:${CONFIG.proxyPort}`);
  console.log(`Proxy user: ${CONFIG.proxyUser}`);
  console.log(`Proxy pass: ${CONFIG.proxyPass.substring(0,6)}****`);
  console.log(`DB: ${CONFIG.dbUrl ? 'configured' : 'MISSING'}`);

  // Test proxy first
  const proxyOk = await testProxy();
  if (!proxyOk) {
    console.error('\nProxy test failed â will still attempt login...');
  }

  // First run
  await runCheck();

  // Loop
  console.log(`\nScheduling checks every ${CONFIG.interval / 1000}s...`);
  setInterval(runCheck, CONFIG.interval);
}

main().catch(err => {
  console.error('STARTUP ERROR:', err);
  process.exit(1);
});
