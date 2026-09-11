/**
 * UI page smoke: loads every web page and flags any 5xx. Auth-redirects and
 * the login page are expected; a 500 means a page failed to render.
 *
 * Run with the web app up.
 */
const BASE = process.env.SMOKE_BASE ?? 'http://localhost:3000';

const PAGES = [
  '/',
  '/guriga',
  '/suuqyada',
  '/suuqyada/0x0000000000000000000000000000000000000001',
  '/hantida',
  '/dhaqdhaqaaq',
  '/dhaqdhaqaaq/00000000-0000-0000-0000-000000000000',
  '/ganacsi',
  '/ganacsi/BTC',
  '/iibso',
  '/boorso',
  '/lacag-gelin',
  '/lacag-qaadasho',
  '/xawilaad',
  '/jeedin',
  '/qorshayaal',
  '/beddel-furaha',
  '/dib-u-deji',
  '/akoon',
  '/gal',
  '/is-diiwaan-geli',
  '/xaqiijin',
  '/xaqiiji-iimaylka',
  '/lacag-bixin',
  '/lacag-fadhiya',
];

async function main(): Promise<void> {
  let failures = 0;
  for (const path of PAGES) {
    try {
      const res = await fetch(BASE + path, {
        redirect: 'manual',
        signal: AbortSignal.timeout(40_000),
      });
      const bad = res.status >= 500;
      if (bad) failures += 1;
      console.info(`${bad ? 'FAIL' : 'ok  '}  ${String(res.status).padEnd(3)} ${path}`);
    } catch (error) {
      failures += 1;
      console.info(`FAIL  ERR  ${path} — ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  console.info(`\n${PAGES.length} pages, ${failures} failing (5xx/network).`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
