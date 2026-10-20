// Confirms the Moolre callback URL actually reaches the route.
//
//   node tests/moolreCallbackUrl.check.js
//
// A callback URL that 404s is the worst kind of wrong: Moolre keeps retrying
// a callback that can never land, and every payment silently sits unsettled
// until someone notices. This mounts the real router and posts to the URL the
// platform hands Moolre, so the two can never drift apart.
process.env.MOOLRE_API_USER = 'test-api-user';
process.env.MOOLRE_API_KEY = 'test-api-key';
process.env.MOOLRE_PUBLIC_KEY = 'test-public-key';
process.env.MOOLRE_ACCOUNT_NUMBER = 'test-account-number';

import express from 'express';
import routes from '../src/routes/index.js';
import { MOOLRE_CALLBACK_URL } from '../src/config/env.js';

const app = express();
app.use(express.json());
app.use('/api', routes);

const server = app.listen(0);
await new Promise((resolve) => server.once('listening', resolve));
const port = server.address().port;

const url = new URL(MOOLRE_CALLBACK_URL);
const target = `http://127.0.0.1:${port}${url.pathname}`;

const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

console.log(`\nCallback URL under test: ${MOOLRE_CALLBACK_URL}\n`);

const res = await fetch(target, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ externalref: 'NOT-A-REAL-REFERENCE' }),
});
const body = await res.json();

check('the callback path is reachable', res.status !== 404, `HTTP ${res.status}`);
check('the handler ran', res.status === 200, `HTTP ${res.status}`);
check(
  'an unknown reference is acknowledged, not crashed on',
  body?.received === true,
  JSON.stringify(body)
);

// The route must not be shadowed by the token routes: `/pay/:token` is one
// segment, `/pay/webhook/moolre` is three.
check('the path is the three-segment one', url.pathname === '/api/pay/webhook/moolre');

server.close();
console.log('');
