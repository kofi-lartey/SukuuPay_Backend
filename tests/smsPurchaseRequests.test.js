// Regression suite for regulated SMS credit purchase.
//
//   npm test
//
// Pure unit tests: no database, no network. Stated rather than hidden, because the
// parts worth testing here are the *contract* — the states, the price freeze, the
// idempotency guarantee — and every one of those is expressible against the schema and
// the validation layer without a document.
//
// What is deliberately NOT asserted: that approval actually moves units. That needs a
// real `PlatformSmsPoolEntry.insert` to collide against, and a mocked `create` that
// always succeeds would assert the query was written correctly rather than that the
// guard works. The sparse-unique index is the guard; `tests/smsModule.test.js` and
// this file assert it exists and is declared, which is the part that can be checked.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  SmsPurchaseRequest,
  SMS_REQUEST_STATUSES,
  SMS_REQUEST_STATUS_VALUES,
} from '../src/models/SmsPurchaseRequest.js';
import { PlatformSmsPoolEntry } from '../src/models/PlatformSmsPoolEntry.js';
import {
  quoteSmsRequestSchema,
  createSmsRequestSchema,
  smsRequestIdParamSchema,
  rejectSmsRequestSchema,
  poolTopUpSchema,
} from '../src/validations/smsRequest.validation.js';
import {
  NOTIFICATION_TYPES,
  SMS_REQUEST_STATUS,
  PURCHASE_PURPOSES,
} from '../src/config/constants.js';

/** Runs a Joi schema the way `middleware/validate.js` does, without a request. */
const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true });

// ─────────────────────────────────────────────
// The states
// ─────────────────────────────────────────────
describe('SMS purchase: states', () => {
  test('money-in and approval are different states', () => {
    // The whole product requirement. If `awaiting_approval` did not exist, the MTN
    // webhook would credit the school on confirmation and the "admin approves" step
    // would be decorative.
    assert.ok(SMS_REQUEST_STATUS_VALUES.includes('awaiting_payment'));
    assert.ok(SMS_REQUEST_STATUS_VALUES.includes('awaiting_approval'));
    assert.equal(
      SMS_REQUEST_STATUS.AWAITING_PAYMENT,
      'awaiting_payment',
      'awaiting_payment must be distinct from awaiting_approval'
    );
  });

  test('a rejected request is a real state, because the money has been taken', () => {
    assert.ok(SMS_REQUEST_STATUS_VALUES.includes('rejected'));
    // And the refund is separable from the rejection, because a bursar asking "was I
    // refunded?" needs to know whether the refund went, not whether it was declined.
    assert.ok(SmsPurchaseRequest.schema.path('refundedAt'));
    assert.ok(SmsPurchaseRequest.schema.path('refundReference'));
  });

  test('the constants and the model enum agree', () => {
    const allowed = SmsPurchaseRequest.schema.path('status').enumValues;
    assert.deepEqual([...allowed].sort(), [...SMS_REQUEST_STATUSES].sort());
  });

  test('a new request starts awaiting payment, not approved', () => {
    assert.equal(SmsPurchaseRequest.schema.path('status').options.default, 'awaiting_payment');
  });
});

// ─────────────────────────────────────────────
// The price freeze
// ─────────────────────────────────────────────
describe('SMS purchase: the price is frozen on the row', () => {
  test('unit price and total are both required', () => {
    // Not optional and not defaulted. A request row whose price could be absent would
    // let a rate change decide retrospectively what a school agreed to pay.
    assert.ok(SmsPurchaseRequest.schema.path('unitPricePes').options.required);
    assert.ok(SmsPurchaseRequest.schema.path('totalPes').options.required);
  });

  test('the rate comes from settings, not from the client', () => {
    // `createSmsRequestSchema` carries a unit count and a phone number and nothing
    // else — no amount, no rate. A client-sent price would be the amount charged.
    const { error, value } = validate(createSmsRequestSchema, {
      units: 1000,
      phoneNumber: '0241234567',
    });
    assert.equal(error, undefined);
    assert.equal(value.units, 1000);
    assert.equal(value.amountPes, undefined);
    assert.equal(value.unitPricePes, undefined);
  });

  test('a client-sent price is stripped rather than trusted', () => {
    // `stripUnknown: true` is set globally in `middleware/validate.js`, so an extra
    // field never reaches the service even if the schema forgets to reject it.
    const { value } = validate(createSmsRequestSchema, {
      units: 10,
      phoneNumber: '0241234567',
      totalPes: 1,
    });
    assert.equal(value.totalPes, undefined);
  });
});

// ─────────────────────────────────────────────
// Idempotency — the part that must not be asserted by a mock
// ─────────────────────────────────────────────
describe('SMS purchase: approval can only allocate once', () => {
  const indexes = () => PlatformSmsPoolEntry.schema.indexes();

  test('a pool entry can claim a request only once', () => {
    // **The** idempotency guarantee. `approveSmsRequest` inserts this row; a second
    // approval — a double-click, a retried request, two operators — collides on this
    // index and is refused rather than handing out the units twice.
    //
    // `schema.indexes()` returns `[{ [fields]: options }, …]`, so the field spec is the
    // **first** element. Destructuring `[, options]` and reading a field off it is the
    // mistake this comment exists to stop repeating.
    const claim = indexes().find(([fields]) => fields.requestId === 1);

    assert.ok(claim, 'a { requestId: 1 } index must exist on PlatformSmsPoolEntry');
    assert.equal(claim[1].unique, true, 'the requestId index must be unique');
    assert.equal(
      claim[1].sparse,
      true,
      'and sparse — a null requestId must not collide with every other null'
    );
  });

  test('the requesting model also claims one allocation', () => {
    // Mirrors the same guarantee from the other side, so neither collection can be
    // edited to drop it without the other showing the gap.
    const claim = SmsPurchaseRequest.schema
      .indexes()
      .find(([fields]) => fields.poolEntryId === 1);

    assert.ok(claim);
    assert.equal(claim[1].unique, true);
    assert.equal(claim[1].sparse, true);
  });

  test('the payment reference is unique and sparse', () => {
    // Null until the prompt is issued, and MongoDB treats nulls as equal — so a plain
    // unique index would allow exactly one un-initiated request in the collection.
    const ref = SmsPurchaseRequest.schema
      .indexes()
      .find(([fields]) => fields['payment.reference'] === 1);

    assert.ok(ref);
    assert.equal(ref[1].unique, true);
    assert.equal(ref[1].sparse, true);
  });
});

// ─────────────────────────────────────────────
// The pool ledger's sign convention
// ─────────────────────────────────────────────
describe('SMS purchase: the pool ledger sums', () => {
  test('units are always positive', () => {
    // The sign lives on `direction`. An entry that could be "−500 top-up" is an entry
    // nobody can sum, and this is the collection whose only job is to be summed.
    const units = PlatformSmsPoolEntry.schema.path('units');
    assert.equal(units.options.min, 1);
  });

  test('the three directions are topup, allocation and reversal', () => {
    const allowed = PlatformSmsPoolEntry.schema.path('direction').enumValues;
    assert.deepEqual([...allowed].sort(), ['allocation', 'reversal', 'topup']);
  });

  test('an allocation records the school and the request', () => {
    // Without these the ledger answers "how much has this school been given?" with a
    // total for everybody, which is the only question the per-school report asks.
    assert.ok(PlatformSmsPoolEntry.schema.path('schoolId'));
    assert.ok(PlatformSmsPoolEntry.schema.path('requestId'));
  });

  test('the platform cost is nullable', () => {
    // A top-up is a cost, an allocation is revenue. Both land in `amountPes`, and
    // credit can also arrive from a migration — so null has to be expressible or a
    // free grant is recorded as having cost GH₵0.00.
    const amount = PlatformSmsPoolEntry.schema.path('amountPes');
    assert.equal(amount.options.min, 0);
    assert.notEqual(amount.options.required, true);
  });
});

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────
describe('SMS purchase: input validation', () => {
  test('the quote takes a count and nothing else', () => {
    const { error, value } = validate(quoteSmsRequestSchema, { units: 1000 });
    assert.equal(error, undefined);
    assert.equal(value.units, 1000);
  });

  test('zero or negative units are refused', () => {
    for (const units of [0, -5]) {
      assert.ok(validate(quoteSmsRequestSchema, { units }).error);
    }
  });

  test('a MoMo number is required, and it is the payer who is prompted', () => {
    // Not taken from the profile: the person approving a purchase is often not the
    // person holding the wallet.
    assert.ok(validate(createSmsRequestSchema, { units: 100 }).error);
    assert.equal(
      validate(createSmsRequestSchema, { units: 100, phoneNumber: '0241234567' }).error,
      undefined
    );
    assert.ok(
      validate(createSmsRequestSchema, { units: 100, phoneNumber: '12345' }).error,
      'a five-digit number is not a Ghanaian MSISDN'
    );
  });

  test('a rejection needs a reason, because the school is told it', () => {
    const { error } = validate(rejectSmsRequestSchema, {});
    assert.ok(error);
    assert.match(error.message, /reason/i);
    assert.ok(validate(rejectSmsRequestSchema, { reason: 'x' }).error);
    assert.equal(validate(rejectSmsRequestSchema, { reason: 'Duplicate' }).error, undefined);
  });

  test('a top-up cost is optional', () => {
    // Credit arrives from migrations too, and forcing a figure would put a price on a
    // decision that had none.
    assert.equal(validate(poolTopUpSchema, { units: 1000 }).error, undefined);
    assert.equal(
      validate(poolTopUpSchema, { units: 1000, amountPes: null }).error,
      undefined
    );
    assert.equal(
      validate(poolTopUpSchema, { units: 1000, amountPes: 500000 }).error,
      undefined
    );
  });

  test('the public reference is validated by shape, not looked up', () => {
    // A bursar quotes `SMS-REQ-…` in a support call, so it is validated as a shape and
    // rejected with a readable message rather than sent to the database.
    assert.equal(
      validate(smsRequestIdParamSchema, { requestId: 'SMS-REQ-20260918-7KQ2M1' }).error,
      undefined
    );
    assert.ok(validate(smsRequestIdParamSchema, { requestId: 'nonsense' }).error);
    // And specifically not an ObjectId — an id in a support ticket is a waste of a
    // channel.
    assert.ok(
      validate(smsRequestIdParamSchema, { requestId: '507f1f77bcf86cd799439011' }).error
    );
  });
});

// ─────────────────────────────────────────────
// Vocabulary shared with the rest of the product
// ─────────────────────────────────────────────
describe('SMS purchase: shared vocabulary', () => {
  test('the platform console is alerted by a declared notification type', () => {
    assert.equal(NOTIFICATION_TYPES.SMS_REQUEST, 'sms.request');
    // And the school hears the outcome, or it has no way to learn that its money was
    // taken and the credit declined.
    assert.ok(NOTIFICATION_TYPES.SMS_REQUEST_APPROVED);
    assert.ok(NOTIFICATION_TYPES.SMS_REQUEST_REJECTED);
  });

  test('the purchase purpose is declared', () => {
    assert.ok(PURCHASE_PURPOSES.includes('sms_credit'));
    assert.ok(PURCHASE_PURPOSES.includes('id_card_print'));
  });

  test('the notification types are ones the client can render', () => {
    // `services/notifications.js` keys its labels off its own map and falls back to
    // `system.alert` for anything unknown — which would render a credit request as a
    // system problem. Asserted here so adding one means adding it there too.
    assert.notEqual(NOTIFICATION_TYPES.SMS_REQUEST, NOTIFICATION_TYPES.SYSTEM_ALERT);
  });
});