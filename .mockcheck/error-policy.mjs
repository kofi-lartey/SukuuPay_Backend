// Confirms the error handler's message policy per status class.
//
//   4xx — the message was written for the user, so it must survive.
//   5xx — the message came from a driver or SDK, so it must not.
import errorHandler from '../src/middleware/errorHandler.js';

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

let pass = 0;
let fail = 0;

const expect = (name, error, status, message) => {
  const res = run(error);
  const ok = res.statusCode === status && res.body.message === message;
  if (ok) {
    pass += 1;
    console.log(`  OK   ${name} — ${res.statusCode} "${res.body.message}"`);
  } else {
    fail += 1;
    console.log(
      `  FAIL ${name} — got ${res.statusCode} "${res.body.message}", expected ${status} "${message}"`
    );
  }
};

// 4xx: ApiError messages are the API's user-facing contract.
expect(
  '400 keeps its message',
  Object.assign(new Error('A schoolId is required to list students'), { status: 400 }),
  400,
  'A schoolId is required to list students'
);
expect(
  '403 keeps its message',
  Object.assign(new Error('No school in scope'), { status: 403 }),
  403,
  'No school in scope'
);
expect(
  '422 keeps its message',
  Object.assign(new Error('"region" must be one of [Ahafo, Ashanti]'), { status: 422 }),
  422,
  '"region" must be one of [Ahafo, Ashanti]'
);

// 5xx: driver and SDK text, which carries hosts, ports, and connection strings.
expect(
  '502 masks a connection error',
  Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:27017 admin:secret@db'), { status: 502 }),
  502,
  'Something went wrong'
);
expect(
  'a statusless error is masked',
  new Error('internal detail naming 10.0.0.5'),
  500,
  'Something went wrong'
);

// The errorHandler must never let a message through with credentials in it,
// whatever status the caller attached.
const leaky = run(Object.assign(new Error('mongodb://user:hunter2@host/db'), { status: 500 }));
if (leaky.body.message.includes('hunter2')) {
  fail += 1;
  console.log('  FAIL a credential-bearing message was exposed');
} else {
  pass += 1;
  console.log('  OK   a credential-bearing message is not exposed');
}

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail === 0 ? 0 : 1);
