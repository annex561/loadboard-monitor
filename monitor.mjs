import axios from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import * as cheerio from 'cheerio';
import pg from 'pg';
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

// ââ Proxy âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function getProxyAgent() {
  // Build proxy URL WITHOUT encodeURIComponent â the underscore in
  // _country-pk was being encoded to %5Fcountry-pk which broke auth.
  const proxyUrl = `http://${CONFIG.proxyUser}:${CONFIG.proxyPass}@${CONFIG.proxyHost}:${CONFIG.proxyPort}`;
  console.log(`  Proxy URL: http://${CONFIG.proxyUser}:${CONFIG.proxyPass.substring(0,6)}****@${CONFIG.proxyHost}:${CONFIG.proxyPort}`);
  return new HttpsProxyAgent(proxyUrl);
}

// ââ Test proxy connectivity âââââââââââââââââââââââââââââââââââââââââââââ
async function testProxy() {
  console.log('\n=== PROXY CONNECTIVITY TEST ===');
  const agent = getProxyAgent();
  try {
    const res = await axios.get('https://ipv4.icanhazip.com', {
      httpsAgent: agent,
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    console.log(`  Status: ${res.status}`);
    console.log(`  IP:     ${res.data.trim()}`);
    console.log('  Proxy is WORKING');
    return true;
  } catch (err) {
    console.error(`  Proxy test FAILED: ${err.message}`);
    if (err.response) {
      console.error(`  Response status: ${err.response.status}`);
      console.error(`  Response headers: ${JSON.stringify(err.response.headers)}`);
    }
    return false;
  }
}

// ââ Cookie helper âââââââââââââââââââââââââââââââââââââââââââââââââââââââ
function extractCookies(res) {
  const raw = res.headers['set-cookie'];
  if (!raw) return '';
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

// ââ Login âââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function login() {
  console.log('\n=== LOGIN FLOW ===');
  const agent = getProxyAgent();

  // Step 1 â GET login page (works without proxy, but we use proxy anyway)
  console.log('Step 1: GET /login');
  const loginPage = await axios.get('https://access-control.sacredcube.co/login', {
    httpsAgent: agent,
    timeout: 30000,
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
  });
  console.log(`  Status: ${loginPage.status}`);
  sessionCookies = extractCookies(loginPage);

  const $ = cheerio.load(loginPage.data);
  csrfToken = $('meta[name="csrf-token"]').attr('content') || $('input[name="_token"]').val();
  console.log(`  CSRF: ${csrfToken ? csrfToken.substring(0, 10) + '...' : 'NOT FOUND'}`);

  // Step 2 â POST login
  console.log('Step 2: POST /login');
  const loginRes = await axios.post('https://access-control.sacredcube.co/login',
    new URLSearchParams({
      _token: csrfToken,
      email: CONFIG.scEmail,
      password: CONFIG.scPassword,
    }).toString(),
    {
      httpsAgent: agent,
      timeout: 30000,
      maxRedirects: 0,
      validateStatus: s => s < 400 || s === 302,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': sessionCookies,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    }
  );
  console.log(`  Status: ${loginRes.status}`);
  sessionCookies = mergeCookies(sessionCookies, extractCookies(loginRes));

  // Step 3 â Follow redirect to TMS
  console.log('Step 3: GET /tms (follow redirect)');
  const tmsPage = await axios.get('https://access-control.sacredcube.co/tms', {
    httpsAgent: agent,
    timeout: 30000,
    headers: {
      'Cookie': sessionCookies,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
  });
  console.log(`  Status: ${tmsPage.status}`);
  sessionCookies = mergeCookies(sessionCookies, extractCookies(tmsPage));
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
  const agent = getProxyAgent();
  const payload = buildPayload();

  try {
    const res = await axios.post(
      'https://access-control.sacredcube.co/nova-vendor/loadboard/loadsAggregate',
      payload,
      {
        httpsAgent: agent,
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'Cookie': sessionCookies,
          'X-CSRF-TOKEN': csrfToken,
          'X-Requested-With': 'XMLHttpRequest',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Referer': 'https://access-control.sacredcube.co/tms',
        },
      }
    );
    console.log(`  Status: ${res.status}`);
    console.log(`  Data type: ${typeof res.data}`);
    if (Array.isArray(res.data)) {
      console.log(`  Results: ${res.data.length} loads`);
    } else if (res.data && res.data.data) {
      console.log(`  Results: ${res.data.data.length} loads (nested)`);
    } else {
      console.log(`  Response keys: ${Object.keys(res.data || {}).join(', ')}`);
    }
    return res.data;
  } catch (err) {
    console.error(`  Search FAILED: ${err.message}`);
    if (err.response) {
      console.error(`  Status: ${err.response.status}`);
      console.error(`  Body: ${JSON.stringify(err.response.data).substring(0, 300)}`);
    }
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
    if (err.response) {
      console.error(`  Status: ${err.response.status}`);
      console.error(`  Headers: ${JSON.stringify(err.response.headers)}`);
    }
    console.error(err.stack);
  }
}

// ââ Main ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
async function main() {
  console.log('Loadboard Monitor v2.2 starting...');
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
