// Verifies the error handler's client-facing behaviour.
//
// Two regressions this covers:
//   1. `express.json()` rejects unparseable bodies with an `entity.parse.failed`
//      SyntaxError. Unhandled, it reached clients as
//      `400 {"stack": "… at /opt/render/project/src/node_modules/…"}` — full
//      server filesystem paths to any anonymous caller.
//   2. The stack was gated on NODE_ENV, so a deployment left in development
//      mode leaked it. The stack must never be sent, in any environment.
import errorHandler from '../src/middleware/errorHandler.js';

let pass = 0;
let fail = 0;

const check = (name, ok, detail) => {
  if (ok) {
    pass += 1;
    console.log(`  OK   ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

/** Calls the middleware and captures what it writes to the response. */
const run = (error) => {
  const res = {
    statusCode: null,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; },
  };
  errorHandler(error, {}, res, () => {});
  return res;
};

const parseError = Object.assign(
  new SyntaxError('Unexpected token \'n\', "not-json" is not valid JSON'),
  { type: 'entity.parse.failed', status: 400, statusCode: 400, expose: true, body: 'not-json' }
);

const withStack = () => {
  const e = new Error('boom from user service');
  e.status = 500;
  return e;
};

// The live-reported case.
await (async () => {
  const res = run(parseError);
  check('malformed JSON is a 400', res.statusCode === 400, `got ${res.statusCode}`);
  check('malformed JSON leaks no stack', !('stack' in res.body), Object.keys(res.body).join(','));
  check(
    'malformed JSON message is plain',
    res.body.message === 'Request body is not valid JSON.',
    res.body.message
  );
  const serialised = JSON.stringify(res.body);
  check(
    'no server paths in the payload',
    !serialised.includes('/opt/render') && !serialised.includes('node_modules'),
    serialised
  );
})();

// A body over the express limit.
await (async () => {
  const res = run(Object.assign(new Error('request entity too large'), { type: 'entity.too.large', status: 413 }));
  check('oversized body is a 413', res.statusCode === 413, `got ${res.statusCode}`);
  check('oversized body leaks no stack', !('stack' in res.body));
})();

// An unhandled 500 must also withhold the stack.
await (async () => {
  const res = run(withStack());
  check('a 500 still returns a response', res.statusCode === 500, `got ${res.statusCode}`);
  check('a 500 leaks no stack', !('stack' in res.body), Object.keys(res.body).join(','));
  check(
    'a 500 uses the generic message',
    res.body.message === 'Something went wrong',
    res.body.message
  );
})();

// The existing, deliberate paths must keep working.
await (async () => {
  const dup = run(Object.assign(new Error('E11000'), { code: 11000, keyValue: { email: 1 } }));
  check('duplicate key is a 409', dup.statusCode === 409, `got ${dup.statusCode}`);
  check('duplicate key names the field', /email/.test(dup.body.message), dup.body.message);
})();

await (async () => {
  const jwt = run(Object.assign(new Error('bad'), { name: 'TokenExpiredError' }));
  check('expired token is a 401', jwt.statusCode === 401, `got ${jwt.statusCode}`);
  check('expired token leaks nothing', Object.keys(jwt.body).join(',') === 'success,message');
})();

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
