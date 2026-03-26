#!/usr/bin/env node

import { loadEnvFile, runSeed, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'economic:econ-calendar:v1';
const CACHE_TTL = 129600; // 36h — 3× a 12h cron interval

// FRED release IDs for major US macro events
// https://api.stlouisfed.org/fred/releases
const FRED_RELEASES = [
  { id: 10,  event: 'CPI',              unit: '%' },
  { id: 50,  event: 'Nonfarm Payrolls', unit: 'K' },
  { id: 53,  event: 'GDP',              unit: '%' },
  { id: 54,  event: 'PCE',              unit: '%' },
  { id: 9,   event: 'Retail Sales',     unit: '%' },
];

// FOMC rate decision dates — Fed publishes full year schedule in advance.
// Source: federalreserve.gov/monetarypolicy/fomccalendars.htm
// Add next year's dates before Dec 31 of the current year to avoid a gap.
const FOMC_DATES_BY_YEAR = {
  2026: ['2026-01-29', '2026-03-19', '2026-05-07', '2026-06-18', '2026-07-30', '2026-09-17', '2026-11-05', '2026-12-17'],
  // 2027: [...] — update when Fed releases the 2027 calendar (typically Nov of prior year)
};

function buildFomcEvents(today) {
  const thisYear = new Date(today).getFullYear();
  const dates = [
    ...(FOMC_DATES_BY_YEAR[thisYear] ?? []),
    ...(FOMC_DATES_BY_YEAR[thisYear + 1] ?? []),
  ];
  return dates
    .filter((d) => d >= today)
    .map((date) => ({
      event: 'FOMC Rate Decision',
      country: 'US',
      date,
      impact: 'high',
      actual: '',
      estimate: '',
      previous: '',
      unit: '',
    }));
}

async function fetchFredReleaseDates(releaseId, apiKey, today, toDate) {
  const url =
    `https://api.stlouisfed.org/fred/release/dates` +
    `?release_id=${releaseId}` +
    `&sort_order=asc` +
    `&limit=1000` +
    `&include_release_dates_with_no_data=true` +
    `&api_key=${apiKey}` +
    `&file_type=json`;

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`FRED release/dates HTTP ${resp.status} (release_id=${releaseId})`);

  const data = await resp.json();
  return (data.release_dates ?? [])
    .map((e) => e.date)
    .filter((d) => d >= today && d <= toDate);
}

async function fetchEconomicCalendar() {
  const apiKey = process.env.FRED_API_KEY;
  const today = new Date().toISOString().slice(0, 10);
  const toDate = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);

  const fomcEvents = buildFomcEvents(today);

  if (!apiKey) {
    console.warn('  FRED_API_KEY missing — returning FOMC dates only');
    const events = fomcEvents;
    return { events, fromDate: today, toDate, total: events.length };
  }

  console.log(`  Fetching FRED economic release calendar ${today} → ${toDate}`);

  const events = [...fomcEvents];

  await Promise.all(
    FRED_RELEASES.map(async ({ id, event, unit }) => {
      const dates = await fetchFredReleaseDates(id, apiKey, today, toDate);
      console.log(`  ${event} (release_id=${id}): ${dates.length} upcoming date(s)`);
      for (const date of dates) {
        events.push({ event, country: 'US', date, impact: 'high', actual: '', estimate: '', previous: '', unit });
      }
    }),
  );

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  console.log(`  Total events: ${events.length}`);

  return { events, fromDate: today, toDate, total: events.length };
}

function validate(data) {
  return Array.isArray(data?.events) && data.events.length > 0;
}

if (process.argv[1]?.endsWith('seed-economic-calendar.mjs')) {
  runSeed('economic', 'econ-calendar', CANONICAL_KEY, fetchEconomicCalendar, {
    validateFn: validate,
    ttlSeconds: CACHE_TTL,
    sourceVersion: 'fred-v1',
  }).catch((err) => {
    const _cause = err.cause ? ` (cause: ${err.cause.message || err.cause.code || err.cause})` : '';
    console.error('FATAL:', (err.message || err) + _cause);
    process.exit(1);
  });
}
