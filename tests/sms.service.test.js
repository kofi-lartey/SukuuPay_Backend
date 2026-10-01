import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractTokens,
  renderBody,
  countSmsParts,
  estimateCost,
  assertTokensValid,
} from '../src/services/sms.service.js';

test('token extraction deduplicates and keeps first-appearance order', () => {
  assert.deepEqual(extractTokens('Hi {parentName}, {studentName} owes {balance} (of {balance})'), [
    'parentName',
    'studentName',
    'balance',
  ]);
  assert.deepEqual(extractTokens('no tokens here'), []);
});

test('renderBody substitutes known values and leaves the rest visible', () => {
  const rendered = renderBody('Hi {parentName}, {balance} by {dueDate}', {
    parentName: 'Mr. Mensah',
    balance: '550.00',
    dueDate: '',
  });
  // The blank date stays as the literal token on purpose: a blank reads as
  // addressed to nobody, and `{dueDate}` is a bug the school can see.
  assert.equal(rendered, 'Hi Mr. Mensah, 550.00 by {dueDate}');
});

test('an unknown token is rejected with the offending name in the message', () => {
  assert.throws(
    () => assertTokensValid('Hi {parentname}'),
    (error) => {
      assert.equal(error.code, 'UNKNOWN_SMS_TOKEN');
      assert.match(error.message, /\{parentname\}/);
      return true;
    }
  );
});

test('every known token is accepted', () => {
  const body = '{parentName} {studentName} {studentClass} {balance} {amountPaid} {dueDate} {schoolName} {payLink} {term}';
  assert.equal(assertTokensValid(body).length, 9);
});

test('segment counting follows the GSM-7 concat rules', () => {
  assert.equal(countSmsParts('a'.repeat(160)), 1);
  assert.equal(countSmsParts('a'.repeat(161)), 2);
  assert.equal(countSmsParts('a'.repeat(313)), 2);
  assert.equal(countSmsParts('a'.repeat(314)), 3);
  assert.equal(countSmsParts(''), 1);
});

test('a non-GSM-7 character halves the characters per segment', () => {
  // An emoji is UCS-2: 70 characters per part, so 71 is already two parts where
  // GSM-7 would have made it one. This is a cost the school must be able to see
  // before sending, not discover on the bill.
  const text = 'a'.repeat(70);
  assert.equal(countSmsParts(text), 1);
  assert.equal(countSmsParts(`${text}\u{1F600}`), 2);
});

test('estimated cost is segments times recipients', () => {
  assert.equal(estimateCost('a'.repeat(400), 87), 3 * 87);
  assert.equal(estimateCost('short', 10), 10);
});
