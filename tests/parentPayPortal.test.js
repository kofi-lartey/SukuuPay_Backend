// Regression suite for the public parent pay portal.
//
//   npm test
//
// Pure unit tests: no database, no network, no live server. Everything here is
// either a pure projection, a schema, or a small piece of arithmetic — which is
// where the portal's real risk lives, because those are the parts that decide what
// crosses the token boundary.
//
// The tests that need a database to be meaningful (does a receipt for another
// student 404? does the webhook pick the right installment?) are not here, and
// pretending otherwise would be worse than their absence: a mocked `findOne` that
// always matches will assert that the query was written correctly, not that the
// authorisation works. Those are worth a real integration suite. What is asserted
// below is the layer that integration would be relying on.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  projectStudent,
  projectSchool,
  projectPlan,
  projectPayment,
  maskContact,
  resolveNetwork,
} from '../src/services/pay.service.js';
import {
  initiatePaymentSchema,
  payTokenParamSchema,
  payReferenceParamSchema,
  payRequestPlanSchema,
  payNotifySchoolSchema,
  payReceiptParamSchema,
  payHistoryQuerySchema,
  PAY_TOKEN_PATTERN,
  PORTAL_NETWORK_ALIASES,
} from '../src/validations/payment.validation.js';
import { generatePaymentReference } from '../src/services/payment.service.js';
import {
  generateReceiptPdf,
  normaliseBreakdown,
  receiptFilename,
} from '../src/utils/receiptService.js';
import { generatePayLinkToken } from '../src/utils/generatePayLink.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true });

/** A student row with every field the portal must *not* return. */
const fullStudent = {
  _id: '507f1f77bcf86cd799439011',
  studentId: 'PBS-2026-0001',
  studentName: 'Kwame Mensah',
  studentClass: 'JHS 2A',
  studentImage: 'https://res.cloudinary.com/demo/kwame.jpg',
  status: 'active',
  totalOwed: 85000,
  totalPaid: 30000,
  balance: 55000,
  deadline: '2026-10-30T23:59:00.000Z',
  // Every one of these must be absent from the response.
  schoolId: '507f1f77bcf86cd799439099',
  uniquePayLinkToken: 'STU-FCFEE2A4',
  payLink: 'https://sukuupay.com/pay/STU-FCFEE2A4',
  createdBy: '507f1f77bcf86cd799439088',
  dateOfBirth: '2015-04-02T00:00:00.000Z',
  gender: 'male',
  classHistory: [{ class: 'JHS 1A' }],
  emergencyContacts: [{ name: 'Auntie', phone: '0249999999' }],
  transferOutRecord: { toSchool: 'Other Basic' },
  statusReason: 'unpaid fees',
  deletedReason: 'transferred',
  parents: [
    { parentName: 'Mrs. Akosua Mensah', relationship: 'Mother', phone: '0244123456', isPrimary: true },
    { parentName: 'Mr. Kojo Mensah', relationship: 'Father', phone: '0551987654' },
  ],
};

// ──────────────────── The projection ────────────────────

describe('parent portal: what crosses the token boundary', () => {
  const projected = projectStudent(fullStudent, NOW);

  test('carries only the fields a parent needs to pay', () => {
    assert.equal(projected.studentName, 'Kwame Mensah');
    assert.equal(projected.studentClass, 'JHS 2A');
    assert.equal(projected.studentId, 'PBS-2026-0001');
    assert.equal(projected.balance, 55000);
    assert.equal(projected.totalOwed, 85000);
    assert.equal(projected.totalPaid, 30000);
    assert.equal(projected.studentImage, fullStudent.studentImage);
  });

  test('exposes no internal handle, secret or unrelated record', () => {
    // The whole list, asserted as a single field-name check so a newly added field
    // on Student fails here rather than shipping to an unauthenticated endpoint.
    const FORBIDDEN = [
      '_id',
      'id',
      'schoolId',
      'uniquePayLinkToken',
      'payLink',
      'createdBy',
      'updatedBy',
      'parents',
      'emergencyContacts',
      'dateOfBirth',
      'gender',
      'classHistory',
      'transferOutRecord',
      'statusReason',
      'deletedReason',
      'deletedAt',
    ];

    for (const field of FORBIDDEN) {
      assert.equal(
        field in projected,
        false,
        `the public student payload must not contain "${field}"`
      );
    }
  });

  test('gives a recognisable but incomplete guardian number', () => {
    assert.equal(projected.primaryParent.parentName, 'Mrs. Akosua Mensah');
    assert.equal(projected.primaryParent.phoneMasked, '•••• 3456');
    // The other guardian is not surfaced at all.
    assert.equal(JSON.stringify(projected).includes('Kojo'), false);
    assert.equal(JSON.stringify(projected).includes('1987654'), false);
  });

  test('leaves the deadline as an ISO string, so the client formats it', () => {
    assert.equal(projected.deadline, '2026-10-30T23:59:00.000Z');
  });
});

// ──────────────────── Overdue arithmetic ────────────────────

describe('parent portal: overdue state', () => {
  const at = (over) => ({
    ...fullStudent,
    balance: over.balance,
    deadline: over.deadline,
  });

  test('not yet due', () => {
    const p = projectStudent(at({ balance: 55000, deadline: '2026-10-30T23:59:00Z' }), NOW);
    assert.equal(p.isOverdue, false);
    assert.equal(p.overdueDays, 0);
    assert.equal(p.daysToDeadline, 27);
  });

  test('overdue, and counts whole days', () => {
    const p = projectStudent(at({ balance: 55000, deadline: '2026-09-28T23:59:00Z' }), NOW);
    assert.equal(p.isOverdue, true);
    assert.equal(p.overdueDays, 5);
  });

  test('a settled student is never overdue, however old the deadline', () => {
    // The case the brief does not mention and that produces the worst support call:
    // a family that paid on time, whose deadline has since passed, being told they
    // are in arrears on the page that is supposed to confirm they are square.
    const p = projectStudent(at({ balance: 0, deadline: '2026-01-01T23:59:00Z' }), NOW);
    assert.equal(p.isOverdue, false);
    assert.equal(p.overdueDays, 0);
  });

  test('a student with no deadline is not overdue', () => {
    const p = projectStudent(at({ balance: 55000, deadline: null }), NOW);
    assert.equal(p.isOverdue, false);
    assert.equal(p.deadline, null);
  });

  test('a malformed deadline does not produce NaN', () => {
    const p = projectStudent(at({ balance: 55000, deadline: 'not-a-date' }), NOW);
    assert.equal(p.isOverdue, false);
    assert.equal(p.deadline, null);
    assert.equal(p.daysToDeadline, null);
  });

  test('an unusable "now" cannot produce NaN', () => {
    // `now` is a parameter, and an invalid one used to reach `Date.UTC(NaN, NaN,
    // NaN)` — so a function guarding its date argument still emitted NaN, which
    // serialises into JSON as `null` while every comparison against it silently
    // went false.
    for (const badNow of ['not-a-date', NaN, new Date('nope')]) {
      const p = projectStudent(at({ balance: 55000, deadline: '2026-10-30T23:59:00Z' }), badNow);
      assert.equal(p.daysToDeadline, null);
      assert.equal(p.isOverdue, false);
      assert.equal(Number.isNaN(p.overdueDays), false);
    }
  });

  test('the day count does not depend on the hour the page is opened', () => {
    // A deadline is a *date*, authored as 23:59 on its last day. Counting from the
    // current instant instead made the same bill read "Due in 28 days" at noon and
    // "Due in 29 days" at midnight, so the page contradicted the SMS that sent the
    // parent there.
    for (const hour of ['00:15', '09:59', '12:00', '23:59']) {
      const now = new Date(`2026-10-03T${hour}:00Z`);
      const p = projectStudent(at({ balance: 55000, deadline: '2026-10-30T23:59:00Z' }), now);
      assert.equal(p.daysToDeadline, 27, `wrong count at ${hour}`);
    }
  });
});

// ──────────────────── Masking ────────────────────

describe('parent portal: phone masking', () => {
  // The regression these guard: the projection this replaced used
  // `phone.replace(/(\d{3})\d{4}(\d{2})/, ...)`, unanchored and assuming ten
  // digits. On the international spellings `phoneNumbers.js` treats as ordinary it
  // produced `233****23456` for `233244123456` — eight of twelve digits published on
  // an endpoint with no authentication.
  const cases = [
    ['0244123456', '•••• 3456'],
    ['233244123456', '•••• 3456'],
    ['+233244123456', '•••• 3456'],
    ['002332441234567', '•••• 4567'],
    ['244123456', '•••• 3456'],
  ];

  for (const [input, expected] of cases) {
    test(`${input} masks to ${expected}`, () => {
      assert.equal(maskContact(input), expected);
    });
  }

  test('reveals no more than the last four digits, at any length', () => {
    for (const [input] of cases) {
      const digits = input.replace(/\D/g, '');
      const revealed = maskContact(input).replace(/\D/g, '');
      assert.equal(revealed, digits.slice(-4));
      assert.ok(revealed.length <= 4, `${input} leaked more than four digits`);
    }
  });

  test('an unusable number yields null, not a mask of nothing', () => {
    assert.equal(maskContact(''), null);
    assert.equal(maskContact(null), null);
    assert.equal(maskContact(undefined), null);
  });
});

// ──────────────────── Plan projection ────────────────────

describe('parent portal: plan projection', () => {
  const plan = (installments) =>
    projectPlan(
      {
        _id: 'plan1',
        planStatus: 'active',
        planName: '3 monthly plan',
        numberOfInstallments: installments.length,
        interval: 'monthly',
        totalAmount: installments.reduce((sum, i) => sum + i.amount, 0),
        installments,
      },
      NOW
    );

  test('marks the earliest unpaid tranche as next, even when it is overdue', () => {
    // The trap: a parent who missed the first two has arrears, not a future payment.
    // Labelling tranche 3 "next" because it is the one not yet due makes a defaulted
    // plan read as healthy.
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 0, dueDate: '2026-08-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-09-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 3, amount: 30000, amountPaid: 0, dueDate: '2026-12-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.nextInstallment.installmentNumber, 1);
    assert.equal(p.installments.filter((i) => i.isNext).length, 1);
    assert.equal(p.installments[0].isOverdue, true);
  });

  test('a fully paid tranche is settled whatever its due date says', () => {
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 30000, dueDate: '2026-09-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-11-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.installments[0].isOverdue, false, 'a paid tranche cannot be overdue');
    assert.equal(p.nextInstallment.installmentNumber, 2);
    assert.equal(p.progressPercent, 50);
  });

  test('a waived tranche is settled and is not "next"', () => {
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 0, dueDate: '2026-08-01T00:00:00Z', status: 'waived' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-11-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.nextInstallment.installmentNumber, 2);
  });

  test('a part-paid tranche reports what is left, not just "partial"', () => {
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 10000, dueDate: '2026-11-01T00:00:00Z', status: 'partial' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-12-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.installments[0].outstanding, 20000);
    assert.equal(p.progressPercent, 17);
  });

  test('"next installment" is what is owed, not what the tranche was sized at', () => {
    // The regression: `nextInstallment.amount` carried the original 30000 for a
    // tranche owing 20000, and the portal pre-fills its payment form from it. The
    // parent tapped the one button meant to make paying easy and got "that is more
    // than the amount outstanding" back from the server.
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 10000, dueDate: '2026-11-01T00:00:00Z', status: 'partial' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-12-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.nextInstallment.amount, 20000);
    assert.equal(p.nextInstallment.outstanding, 20000);
  });

  test('a fully-collected tranche is settled even when its status says pending', () => {
    // `PaymentPlan`'s pre-save hook keeps `status` current, but it only runs on
    // save. Reading `status` alone marked this row overdue *and* offered it again as
    // "Pay next installment" — an amber "32 days late" pill on money already
    // collected, and a button to pay it twice.
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 30000, dueDate: '2026-09-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-11-01T00:00:00Z', status: 'pending' },
    ]);

    assert.equal(p.installments[0].settled, true);
    assert.equal(p.installments[0].isOverdue, false);
    assert.equal(p.nextInstallment.installmentNumber, 2);
  });

  test('a settled plan has no next installment', () => {
    const p = plan([
      { installmentNumber: 1, amount: 30000, amountPaid: 30000, dueDate: '2026-08-01T00:00:00Z', status: 'paid' },
      { installmentNumber: 2, amount: 30000, amountPaid: 30000, dueDate: '2026-09-01T00:00:00Z', status: 'paid' },
    ]);

    assert.equal(p.nextInstallment, null);
    assert.equal(p.progressPercent, 100);
    assert.equal(p.totalRemaining, 0);
  });

  test('an empty plan does not produce NaN anywhere', () => {
    const p = projectPlan({ _id: 'p', planStatus: 'active', totalAmount: 0, installments: [] }, NOW);
    assert.equal(p.progressPercent, 0);
    assert.equal(p.totalPaid, 0);
    assert.equal(p.totalRemaining, 0);
    assert.equal(p.nextInstallment, null);
  });

  test('installments come back in order regardless of how they were stored', () => {
    const p = plan([
      { installmentNumber: 3, amount: 30000, amountPaid: 0, dueDate: '2026-12-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 1, amount: 30000, amountPaid: 0, dueDate: '2026-10-01T00:00:00Z', status: 'pending' },
      { installmentNumber: 2, amount: 30000, amountPaid: 0, dueDate: '2026-11-01T00:00:00Z', status: 'pending' },
    ]);

    assert.deepEqual(p.installments.map((i) => i.installmentNumber), [1, 2, 3]);
  });
});

// ──────────────────── School and payment projection ────────────────────

describe('parent portal: school projection', () => {
  const school = projectSchool({
    name: 'Prampram Basic School',
    logo: 'https://cdn/logo.png',
    brandColor: '#0A5C36',
    phone: '+233244567890',
    email: 'info@pramprambasic.edu.gh',
    // None of these may cross: payment credentials and configuration are the most
    // damaging thing on the model to publish through a shared link.
    payment: { hubtelClientSecret: 'super-secret' },
    sms: { arkeselApiKey: 'super-secret' },
    featureFlags: { beta: true },
    internalNotes: 'do not publish',
    accountManagerId: 'someone',
    _id: 'school1',
  });

  test('carries the published contact details', () => {
    assert.equal(school.name, 'Prampram Basic School');
    assert.equal(school.phone, '+233244567890');
    assert.equal(school.email, 'info@pramprambasic.edu.gh');
    assert.equal(school.brandColor, '#0A5C36');
  });

  test('carries no gateway credentials or configuration', () => {
    const serialised = JSON.stringify(school);
    for (const secret of ['super-secret', 'hubtelClientSecret', 'arkeselApiKey', 'internalNotes']) {
      assert.equal(serialised.includes(secret), false, `school payload leaked "${secret}"`);
    }
    assert.equal('payment' in school, false);
    assert.equal('_id' in school, false);
  });

  test('a missing school projects to null rather than throwing', () => {
    assert.equal(projectSchool(null), null);
    assert.equal(projectSchool(undefined), null);
  });
});

describe('parent portal: payment projection', () => {
  test('reports a cash payment with no network rather than "UNKNOWN"', () => {
    const p = projectPayment({
      paymentId: 'PAY-1',
      amount: 55000,
      receiptNumber: 'RCT-2026-0142',
      momoNetwork: 'UNKNOWN',
      paymentMethod: 'cash',
      status: 'completed',
      completedAt: '2026-09-20T10:15:30.000Z',
      createdAt: '2026-09-20T10:15:00.000Z',
    });

    assert.equal(p.network, null, '"UNKNOWN" renders as a dash, not as a network name');
    assert.equal(p.paymentId, 'PAY-1');
    assert.equal(p.receiptNumber, 'RCT-2026-0142');
  });

  test('keeps a real network', () => {
    const p = projectPayment({ paymentId: 'P', amount: 1, momoNetwork: 'MTN', paymentMethod: 'momo' });
    assert.equal(p.network, 'MTN');
  });
});

// ──────────────────── Network aliasing ────────────────────

describe('parent portal: network naming', () => {
  test('a parent\'s word for their network maps to the stored enum', () => {
    assert.equal(resolveNetwork('Telecel'), 'VODAFONE');
    assert.equal(resolveNetwork('telecel'), 'VODAFONE');
    assert.equal(resolveNetwork('AirtelTigo'), 'AIRTELTELIGO');
    assert.equal(resolveNetwork('airtel'), 'AIRTELTELIGO');
    assert.equal(resolveNetwork('MTN'), 'MTN');
    assert.equal(resolveNetwork('mtn'), 'MTN');
  });

  test('an unrecognised network degrades to UNKNOWN, it does not throw', () => {
    // The gateway resolves the operator from the number's prefix, so a misspelling
    // must not block a payment the gateway would have routed correctly.
    assert.equal(resolveNetwork('Unicom'), 'UNKNOWN');
    assert.equal(resolveNetwork(''), 'UNKNOWN');
    assert.equal(resolveNetwork(null), 'UNKNOWN');
  });

  test('every alias key is a legal identifier for the schema', () => {
    for (const key of Object.keys(PORTAL_NETWORK_ALIASES)) {
      assert.ok(
        !validate(initiatePaymentSchema, { amount: 100, phone: '0241234567', network: key }).error,
        `"${key}" should be accepted by initiatePaymentSchema`
      );
    }
  });
});

// ──────────────────── Validation ────────────────────

describe('parent portal: initiate validation', () => {
  test('accepts the admin spelling and the parent spelling of one request', () => {
    assert.ok(
      !validate(initiatePaymentSchema, {
        amount: 5000,
        phoneNumber: '0241234567',
        momoNetwork: 'MTN',
      }).error,
      'the admin Payments screen must keep working'
    );

    assert.ok(
      !validate(initiatePaymentSchema, {
        amount: 5000,
        phone: '0241234567',
        network: 'Telecel',
      }).error,
      'the portal must work in its own vocabulary'
    );
  });

  test('refuses an amount below one cedi', () => {
    const { error } = validate(initiatePaymentSchema, { amount: 99, phone: '0241234567' });
    assert.ok(error);
    assert.match(error.message, /GH₵ 1\.00/);
  });

  test('refuses a non-Ghanaian or malformed phone number', () => {
    for (const phone of ['12345', '0812345678', 'abcdefghij', '+44 7700 900000']) {
      const { error } = validate(initiatePaymentSchema, { amount: 5000, phone });
      assert.ok(error, `${phone} should have been rejected`);
    }
  });

  test('requires a phone number only for MoMo, not card payments', () => {
    // Card payments (Paystack) do not need a phone number.
    const { error: cardError } = validate(initiatePaymentSchema, {
      amount: 5000,
      paymentMethod: 'card',
    });
    assert.ok(!cardError, 'card payments should not require a phone number');

    // MoMo payments still need a phone number.
    const { error: momoError } = validate(initiatePaymentSchema, {
      amount: 5000,
      paymentMethod: 'momo',
    });
    assert.ok(momoError, 'MoMo payments should require a phone number');
  });

  test('refuses a network outside the three operators', () => {
    const { error } = validate(initiatePaymentSchema, {
      amount: 5000,
      phone: '0241234567',
      network: 'Glo',
    });
    assert.ok(error);
  });
});

describe('parent portal: pay token validation', () => {
  test('accepts a real token', () => {
    assert.ok(!validate(payTokenParamSchema, { token: 'STU-FCFEE2A4' }).error);
  });

  test('every token the generator can produce passes the schema', () => {
    // The pairing that matters: the generator and the validator must agree, or the
    // portal 422s a token it just issued.
    for (let i = 0; i < 200; i += 1) {
      const token = generatePayLinkToken();
      assert.match(token, PAY_TOKEN_PATTERN, `${token} failed the shared pattern`);
      assert.ok(!validate(payTokenParamSchema, { token }).error, `${token} was rejected`);
    }
  });

  test('refuses a token with non-hex letters', () => {
    // `STU-8F3K9D2L` appeared as the example token in `generatePayLink.js` for the
    // life of the file. `randomBytes().toString('hex')` cannot produce `K` or `L`,
    // so the validator rejects it — which made the documented example a trap for
    // anyone writing a fixture from it.
    assert.ok(validate(payTokenParamSchema, { token: 'STU-8F3K9D2L' }).error);
  });

  test('refuses an over-long or empty token', () => {
    assert.ok(validate(payTokenParamSchema, { token: 'STU-FCFEE2A4AA' }).error);
    assert.ok(validate(payTokenParamSchema, { token: '' }).error);
  });
});

describe('parent portal: receipt param validation', () => {
  test('accepts both path parameters in one schema', () => {
    // The route used to chain two `params` schemas. `validate` writes back the
    // validated value with `stripUnknown: true`, so the first deleted `paymentId`
    // and the second rejected every request — the endpoint had never served a
    // receipt. One schema per segment.
    const { error, value } = validate(payReceiptParamSchema, {
      token: 'STU-FCFEE2A4',
      paymentId: 'PAY-2026-0001',
    });

    assert.ok(!error);
    assert.equal(value.token, 'STU-FCFEE2A4');
    assert.equal(value.paymentId, 'PAY-2026-0001');
  });

  test('still rejects a missing or malformed payment id', () => {
    assert.ok(validate(payReceiptParamSchema, { token: 'STU-FCFEE2A4' }).error);
    assert.ok(validate(payReceiptParamSchema, { token: 'STU-FCFEE2A4', paymentId: 'x' }).error);
  });
});

describe('parent portal: verify reference validation', () => {
  test('accepts a reference the generator produced', () => {
    for (let i = 0; i < 100; i += 1) {
      const reference = generatePaymentReference();
      const { error } = validate(payReferenceParamSchema, { token: 'STU-FCFEE2A4', reference });
      assert.ok(!error, `${reference} was rejected by its own schema`);
    }
  });

  test('references are unique enough not to collide under load', () => {
    // Five initiations in the same millisecond is ordinary on a busy morning, and
    // the limiter is per token so two different tokens can be initiated together.
    const seen = new Set();
    for (let i = 0; i < 5000; i += 1) seen.add(generatePaymentReference());
    assert.equal(seen.size, 5000);
  });

  test('refuses an arbitrary transaction id as a reference', () => {
    // Otherwise this endpoint is a lookup for any payment on the platform.
    for (const reference of ['x', 'MTN-GH-8942103', 'SUK-abc', "SUK-1234567890-A'B"]) {
      assert.ok(
        validate(payReferenceParamSchema, { token: 'STU-FCFEE2A4', reference }).error,
        `${reference} should have been refused`
      );
    }
  });
});

describe('parent portal: plan request validation', () => {
  const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);

  test('accepts a reasonable request', () => {
    assert.ok(
      !validate(payRequestPlanSchema, {
        numberOfInstallments: 3,
        interval: 'monthly',
        startDate: future,
      }).error
    );
  });

  test('refuses a start date in the past', () => {
    const { error } = validate(payRequestPlanSchema, {
      numberOfInstallments: 3,
      startDate: '2020-01-01',
    });
    assert.ok(error);
    assert.match(error.message, /future/i);
  });

  test('refuses fewer than two or more than six instalments', () => {
    for (const n of [1, 7, 0, -1]) {
      assert.ok(
        validate(payRequestPlanSchema, { numberOfInstallments: n, startDate: future }).error,
        `${n} instalments should have been refused`
      );
    }
  });

  test('does not offer a custom schedule', () => {
    // A custom schedule needs per-tranche amounts and dates, which three segmented
    // options cannot supply; offering it produces a request the school must rewrite.
    const { error } = validate(payRequestPlanSchema, {
      numberOfInstallments: 3,
      interval: 'custom',
      startDate: future,
    });
    assert.ok(error);
  });

  test('defaults the interval to monthly when omitted', () => {
    const { value } = validate(payRequestPlanSchema, {
      numberOfInstallments: 3,
      startDate: future,
    });
    assert.equal(value.interval, 'monthly');
  });
});

describe('parent portal: contact-school validation', () => {
  test('accepts a real message', () => {
    assert.ok(
      !validate(payNotifySchoolSchema, {
        parentName: 'Mrs. Akosua Mensah',
        parentPhone: '0244123456',
        message: 'I paid 300 cedis at the office last Friday but it is not showing.',
      }).error
    );
  });

  test('refuses a message too short to be answerable', () => {
    // A support inbox that accepts "?" gets "?" four times.
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      message: '?',
    });
    assert.ok(error);
    assert.match(error.message, /at least a short message/i);
  });

  test('refuses an over-long message', () => {
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      message: 'x'.repeat(1001),
    });
    assert.ok(error);
  });

  test('requires a phone the bursar can call back on', () => {
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '123',
      message: 'The balance looks wrong to me, please check.',
    });
    assert.ok(error);
  });
});

describe('parent portal: history pagination', () => {
  test('defaults to the first page of twenty', () => {
    const { value } = validate(payHistoryQuerySchema, {});
    assert.equal(value.page, 1);
    assert.equal(value.perPage, 20);
  });

  test('refuses a page size that would pull the whole table', () => {
    assert.ok(validate(payHistoryQuerySchema, { perPage: 500 }).error);
    assert.ok(validate(payHistoryQuerySchema, { page: 0 }).error);
  });
});

// ──────────────────── The receipt ────────────────────

describe('parent portal: receipt PDF', () => {
  const payment = {
    receiptNumber: 'RCT-2026-0142',
    paymentId: 'PAY-2026-0001',
    amount: 55825,
    feesBreakdown: [
      { label: 'School Fee', amount: 55000 },
      { label: 'Service Fee (1.5%)', amount: 825 },
    ],
    completedAt: '2026-10-29T10:42:00.000Z',
    paymentMethod: 'momo',
    reference: 'SUK-1735302930-AB12CD',
  };

  test('renders a real PDF', async () => {
    const buffer = await generateReceiptPdf(payment, {
      student: { studentName: 'Kwame Mensah', studentId: 'PBS-2026-0001', studentClass: 'JHS 2A' },
      school: { name: 'Prampram Basic School', brandColor: '#0A5C36' },
    });

    assert.ok(Buffer.isBuffer(buffer));
    assert.ok(buffer.length > 500, 'a receipt of 500 bytes is suspiciously small');
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('renders even with no student, no school and no breakdown', async () => {
    const buffer = await generateReceiptPdf({ amount: 55000 }, {});
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('falls back to one line when the breakdown is unusable', () => {
    assert.deepEqual(normaliseBreakdown([], 55000), [{ label: 'School fees', amount: 55000 }]);
    assert.deepEqual(normaliseBreakdown([{ label: '', amount: 'x' }], 55000), [
      { label: 'School fees', amount: 55000 },
    ]);
    // A zero line would render as "GHS 0.00" and read as a mistake.
    assert.equal(normaliseBreakdown([{ label: 'Waived', amount: 0 }], 55000).length, 1);
  });

  test('a non-reconciling breakdown still renders', async () => {
    // The receipt says so on its face rather than showing a total that contradicts
    // its own lines — a bursar reconciling this needs to see the discrepancy.
    const buffer = await generateReceiptPdf(
      { ...payment, amount: 99999 },
      { student: {}, school: {} }
    );
    assert.equal(buffer.subarray(0, 5).toString('latin1'), '%PDF-');
  });

  test('the filename cannot carry a header injection', () => {
    // `Content-Disposition` is built from this. A quote or CRLF in a receipt number
    // is response splitting, and receipt numbers are generated but not unforgeable
    // on legacy rows.
    const hostile = receiptFilename('RCT"; drop\r\nSet-Cookie: x=y.pdf');
    assert.equal(hostile.includes('"'), false);
    assert.equal(hostile.includes('\r'), false);
    assert.equal(hostile.includes('\n'), false);
    assert.match(hostile, /\.pdf$/);
  });

  test('the filename falls back rather than being empty', () => {
    assert.equal(receiptFilename('', 'PAY-1'), 'PAY-1.pdf');
    assert.equal(receiptFilename(null, null), 'receipt.pdf');
    assert.equal(receiptFilename('///', null), 'receipt.pdf');
  });
});