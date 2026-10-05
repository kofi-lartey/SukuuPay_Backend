// Regression suite for parent → school messaging, and for the four defects that
// made it undeliverable.
//
//   npm test
//
// Pure unit tests: no database, no network, no live server. That is a real limit and
// it is stated rather than papered over. What is asserted here is the layer an
// integration suite would sit on top of — the validation contract, the model shape,
// the route wiring — plus the *presence* of the things whose absence was the bug. A
// mocked `findOne` that always matches asserts the query was written correctly, not
// that the authorisation works; pretending otherwise would be worse than leaving
// these out.
//
// Each block names the defect it is holding shut.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { payNotifySchoolSchema } from '../src/validations/payment.validation.js';
import {
  ParentMessage,
  PARENT_MESSAGE_STATUSES,
  PARENT_AUDIO_MIME_TYPES,
} from '../src/models/ParentMessage.js';
import {
  listParentMessagesSchema,
  resolveParentMessageSchema,
  parentMessageIdParamSchema,
} from '../src/validations/parentMessage.validation.js';
import { exposeParentAudioToBody } from '../src/middleware/upload.js';
import { NOTIFICATION_TYPES, AUDIT_ACTIONS } from '../src/config/constants.js';
import { notificationQuerySchema } from '../src/validations/notification.validation.js';
import parentMessageRoute from '../src/routes/parentMessage.routes.js';
import adminRoute from '../src/routes/admin.routes.js';
import smsRoute from '../src/routes/sms.routes.js';

/**
 * Runs a Joi schema the way `middleware/validate.js` does, without a request.
 *
 * The middleware itself is `(schema) => (req, res, next)`, so calling it as
 * `validate(schema, payload)` returns a *function* — truthy, and with no `.error` on
 * it. Every "this must be rejected" assertion silently passed against that, which is
 * worth naming: a test helper that cannot fail is worse than no helper.
 */
const validate = (schema, payload) =>
  schema.validate(payload, { abortEarly: true, stripUnknown: true });

// ─────────────────────────────────────────────
// Defect 1 — the audit action was in neither enum
// ─────────────────────────────────────────────
describe('parent messaging: audit actions are writable', () => {
  // The old code called `auditService.log({ action: 'PARENT_CONTACTED_SCHOOL' })`.
  // That string is in neither list, so Mongoose rejected it and
  // `utils/auditService.log` swallowed the ValidationError into a `console.error`.
  // The endpoint still answered 200, so every parent message in the product's
  // history wrote no audit row and nobody found out.
  test('the action the service logs exists in the constants map', () => {
    assert.equal(AUDIT_ACTIONS.PARENT_MESSAGE_SENT, 'parent.message_sent');
  });

  test('every parent-message action is in the AuditLog enum', async () => {
    // The schema enum is not exported, so it is read off the model — which is the
    // authoritative list, and the one that actually rejects the write.
    const path = ParentMessage.schema.path('schoolId');
    assert.ok(path, 'ParentMessage should carry a schoolId');

    const { AuditLog } = await import('../src/models/AuditLog.js');
    const allowed = AuditLog.schema.path('action').enumValues;

    for (const value of [
      AUDIT_ACTIONS.PARENT_MESSAGE_SENT,
      AUDIT_ACTIONS.PARENT_MESSAGE_READ,
      AUDIT_ACTIONS.PARENT_MESSAGE_RESOLVED,
    ]) {
      assert.ok(
        allowed.includes(value),
        `${value} is in constants.js but not in the AuditLog enum — the write will fail validation`
      );
    }
  });

  test('the old, invalid action string is not passed to the audit service', async () => {
    // Guards the regression at its source rather than at the model. Scoped to an
    // `action:` assignment rather than a bare substring, because the string that
    // silently failed is named in the comment above the call — explaining why the old
    // value was invalid is the point of that comment, and a naive scan would forbid
    // documenting the bug it describes.
    const { readFile } = await import('node:fs/promises');
    const source = await readFile(
      new URL('../src/services/pay.service.js', import.meta.url),
      'utf8'
    );

    // Both shapes an `action:` takes: a bare string literal, and a reference into the
    // shared map. Matching only one of them would have let the other regress unnoticed,
    // which is how the first version of this test passed against a file it should have
    // failed.
    const literals = [...source.matchAll(/action:\s*['"`]([^'"`]+)['"`]/g)].map(
      (match) => match[1]
    );
    const references = [...source.matchAll(/action:\s*AUDIT_ACTIONS\.(\w+)/g)].map(
      (match) => match[1]
    );

    for (const action of literals) {
      assert.ok(
        !action.includes('PARENT_CONTACTED_SCHOOL'),
        'pay.service.js must not pass an action that is in no enum'
      );
    }
    assert.ok(
      references.includes('PARENT_MESSAGE_SENT'),
      'pay.service.js should log the shared PARENT_MESSAGE_SENT action'
    );
  });
});

// ─────────────────────────────────────────────
// Every audit action in the codebase is writable
// ─────────────────────────────────────────────
describe('audit actions: nothing is written to nowhere', () => {
  /**
   * The whole failure mode here was silence.
   *
   * `utils/auditService.log` catches the Mongoose ValidationError that an `action`
   * outside the enum raises and logs it. The request succeeds, the endpoint returns 200,
   * and the audit row does not exist. Fifty-three call sites were in that state —
   * `CREATE`, `UPDATE`, `REMOVE`, `BULK_ARCHIVE`, `ANALYTICS_READ` — in UPPER_SNAKE while
   * the vocabulary is dotted lowercase, so a full school year of student lifecycle, bulk
   * operations and plan changes was missing with only a console line as evidence.
   *
   * A parity test between the constants map and the schema enum is not enough on its
   * own: it proved the two *lists* agreed while every *call site* was outside both. This
   * sweeps the source, which is the only place the bug was visible.
   */
  const KNOWN_NON_ACTIONS = new Map([
    // Return values and helper markers, not audit calls. Named rather than pattern-matched
    // so that "the sweep stopped reporting these" has to be a decision someone made.
    ['created', 'src/boot/ensureSuperAdmin.js — a return value'],
    ['none', 'src/services/whatsapp.service.js — a return value'],
    ['plan_accept', 'src/services/whatsapp.service.js — a return value'],
  ]);

  const walk = (dir, out = []) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (entry.endsWith('.js')) out.push(full);
    }
    return out;
  };

  test('no `action:` literal is outside the AuditLog enum', async () => {
    const { AuditLog } = await import('../src/models/AuditLog.js');
    const allowed = new Set(AuditLog.schema.path('action').enumValues);

    const root = fileURLToPath(new URL('../src', import.meta.url));
    const offenders = [];

    for (const file of walk(root)) {
      const source = readFileSync(file, 'utf8');
      const pattern = /action:\s*['"]([A-Za-z_.]+)['"]/g;
      let match;
      while ((match = pattern.exec(source))) {
        const action = match[1];
        if (allowed.has(action) || KNOWN_NON_ACTIONS.has(action)) continue;
        offenders.push(
          `${action} — ${relative(root, file).replace(/\\/g, '/')}`
        );
      }
    }

    assert.deepEqual(
      offenders,
      [],
      `these actions write no audit row:\n      ${offenders.join('\n      ')}`
    );
  });

  test('the known non-actions are still the only exemptions', async () => {
    // Guards the exemption list itself. If someone adds an action to it to make the
    // sweep above pass, this fails — which is the point of naming the reasons.
    const { AuditLog } = await import('../src/models/AuditLog.js');
    const allowed = new Set(AuditLog.schema.path('action').enumValues);

    for (const literal of KNOWN_NON_ACTIONS.keys()) {
      assert.ok(
        !allowed.has(literal),
        `${literal} is now a real enum value, so it no longer needs an exemption`
      );
    }
  });

  test('student.archive and school.archive are different actions', async () => {
    const { AuditLog } = await import('../src/models/AuditLog.js');
    const allowed = AuditLog.schema.path('action').enumValues;

    // An earlier normalisation pass keyed the map on the bare literal `ARCHIVE` and sent
    // both `student.service.js` and `school.service.js` to `student.archive`, which
    // would have made archiving a school indistinguishable from archiving a student in
    // the one log that exists to tell them apart.
    assert.ok(allowed.includes('student.archive'));
    assert.ok(allowed.includes('school.archive'));
  });

  test('bulk operations carry a `bulk.` prefix', async () => {
    const { AuditLog } = await import('../src/models/AuditLog.js');
    const allowed = AuditLog.schema.path('action').enumValues;

    // So "one student or the whole school" is answerable from the action alone, without
    // reading the entity id.
    for (const action of allowed.filter((value) => value.includes('student_'))) {
      if (action.startsWith('student.')) continue;
      assert.ok(
        action.startsWith('bulk.'),
        `${action} looks like a single-student operation but is not prefixed`
      );
    }
  });
});

// ─────────────────────────────────────────────
// Defect 2 — notification types drifted, so the inbox could not be filtered
// ─────────────────────────────────────────────
describe('parent messaging: notification types', () => {
  test('the parent message types are declared', () => {
    assert.equal(NOTIFICATION_TYPES.PARENT_MESSAGE, 'parent.message');
    assert.equal(NOTIFICATION_TYPES.PARENT_AUDIO_MESSAGE, 'parent.audio_message');
  });

  test('?type=parent.message is accepted by the query schema', () => {
    // This answered **422** before. `notificationQuerySchema` carried a hand-written
    // copy of eight types while the model's enum held eleven, and the three missing
    // ones were exactly the pay-portal types. The schema now imports the shared list,
    // so a type in the collection is a type that can be filtered.
    const { error } = validate(notificationQuerySchema, { type: 'parent.message' });
    assert.equal(error, undefined);
  });

  test('?type=parent.audio_message is accepted', () => {
    const { error } = validate(notificationQuerySchema, { type: 'parent.audio_message' });
    assert.equal(error, undefined);
  });

  test('the other drifted types are filterable too', () => {
    for (const type of ['school.join_request', 'plan.requested']) {
      const { error } = validate(notificationQuerySchema, { type });
      assert.equal(error, undefined, `${type} should be filterable`);
    }
  });

  test('an unknown type is still rejected', () => {
    const { error } = validate(notificationQuerySchema, { type: 'not.a.real.type' });
    assert.ok(error, 'the schema must not become permissive by being derived');
  });
});

// ─────────────────────────────────────────────
// Defect 3 — no durable record, and an unguarded SMS
// ─────────────────────────────────────────────
describe('parent messaging: the message is a record', () => {
  test('a voice note alone is a complete message', () => {
    // The parent who cannot comfortably type is the one the recorder exists for, so a
    // schema demanding text would have made the feature unusable for exactly them.
    const { error, value } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      audio: { filename: 'note.webm', size: 120000 },
    });
    assert.equal(error, undefined);
    assert.ok(value, 'a submission with only audio must validate');
  });

  test('text alone is still a complete message', () => {
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      message: 'I paid 300 cedis at the office and it is not showing.',
    });
    assert.equal(error, undefined);
  });

  test('neither text nor audio is refused', () => {
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
    });
    assert.ok(error, 'an empty message must not be accepted');
  });

  test('a too-short message is still refused', () => {
    // The floor has to survive the change to `.allow('')`. Dropping it let "?" through,
    // and an inbox that accepts "?" is one that gets "?" three times a day — which is
    // the server's whole rate limit spent on nothing.
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      message: '?',
    });
    assert.ok(error);
    assert.match(error.message, /at least a short message/i);
  });

  test('a callback phone is still required', () => {
    const { error } = validate(payNotifySchoolSchema, {
      parentName: 'Mrs. Mensah',
      parentPhone: '123',
      message: 'I need to speak to someone about the fees today.',
    });
    assert.ok(error);
  });

  test('the model keeps the parent number in full', () => {
    // The `Notification` copy is masked because it is read by every admin in the
    // school. This row is the school's own record of who contacted them, and a
    // bursar cannot return a call without it.
    const phone = ParentMessage.schema.path('parentPhone');
    assert.ok(phone);
    // Truthiness rather than `=== true`: Mongoose 9 lets `required` be a function or
    // `{ isRequired }`, and asserting strict identity against `true` would fail on a
    // perfectly valid declaration that this test has no reason to police.
    assert.ok(phone.options.required, 'parentPhone must be required');
  });

  test('the model records why an alert was not sent', () => {
    // "No admin has a phone" and "the gateway rejected it" are different problems
    // with different fixes, and the bursar asks why weeks later — by which time the
    // admin list may have changed.
    assert.ok(ParentMessage.schema.path('smsAlerted'));
    assert.ok(ParentMessage.schema.path('smsAlertFailure'));
  });

  test('the model denormalises the student for later reading', () => {
    for (const field of ['studentRef', 'studentName', 'studentClass']) {
      assert.ok(
        ParentMessage.schema.path(field),
        `${field} should be denormalised onto the message`
      );
    }
  });
// ─────────────────────────────────────────────────────────────────────
  // The voice note, as the *route* actually assembles it
  // ─────────────────────────────────────────────
  //
  // Asserted through `exposeParentAudioToBody` and the real schema, because the bug was
  // never in either piece — it was in what sat between them. Testing the schema alone
  // passes: hand it `{ audio: {...} }` and the rule works. Testing multer alone passes:
  // the file lands on `req.file`. The failure only exists in the assembled chain, and
  // the chain is what runs.
  test('a voice note with no text is accepted end to end', () => {
    const expose = exposeParentAudioToBody;
    assert.equal(typeof expose, 'function');

    // What multer leaves behind for a multipart submission that carried only a file.
    const req = {
      file: { filename: 'voice-note.webm', size: 120_000, mimetype: 'audio/webm' },
      body: { parentName: 'Mrs. Mensah', parentPhone: '0244123456' },
    };

    assert.equal(
      req.body.audio,
      undefined,
      'precondition: multer leaves no `audio` key in the body'
    );

    expose(req, {}, () => {});

    // The real schema, on the real post-multer body.
    const { error } = validate(payNotifySchoolSchema, req.body);
    assert.equal(
      error,
      undefined,
      'a recording with no text must be a complete message — this was the 422'
    );
  });

  test('the marker is the file’s identity, not its contents', () => {
    // Joi must never be handed the bytes. A `Buffer` in the validated value would be
    // deep-cloned on every validation pass and then duplicated by `stripUnknown`,
    // while `req.file` already holds the original.
    const req = {
      file: { filename: 'voice-note.webm', size: 900_000, mimetype: 'audio/webm' },
      body: { parentName: 'Mrs. Mensah', parentPhone: '0244123456' },
    };
    exposeParentAudioToBody(req, {}, () => {});

    assert.deepEqual(req.body.audio, { filename: 'voice-note.webm', size: 900_000 });
    assert.ok(!Buffer.isBuffer(req.body.audio), 'Joi must never see the bytes');
  });

  test('a JSON submission is left completely untouched', () => {
    // The middleware must be a no-op without a file, or it would add an `audio` key to
    // every text-only message and quietly change what validates.
    const req = { body: { parentName: 'Mrs. Mensah', parentPhone: '0244123456', message: 'A real message about fees.' } };
    const before = JSON.stringify(req.body);

    exposeParentAudioToBody(req, {}, () => {});

    assert.equal(JSON.stringify(req.body), before);
    assert.equal(req.body.audio, undefined);
  });

  test('text alone still works, and still needs real words', () => {
    const withText = {
      parentName: 'Mrs. Mensah',
      parentPhone: '0244123456',
      message: 'I paid 300 cedis at the office and it is not showing.',
    };
    assert.equal(validate(payNotifySchoolSchema, withText).error, undefined);

    // The floor survives the audio path — the parent who sends "?" has not used the
    // recorder, and still gets told to write something real.
    assert.ok(validate(payNotifySchoolSchema, { ...withText, message: '?' }).error);
  });

  test('neither a recording nor text is still refused', () => {
    const req = {
      body: { parentName: 'Mrs. Mensah', parentPhone: '0244123456' },
    };
    exposeParentAudioToBody(req, {}, () => {});

    const { error } = validate(payNotifySchoolSchema, req.body);
    assert.ok(error, 'an empty submission must still be refused');
  });

  test('the Cloudinary public id is never selected by default', () => {
    assert.equal(ParentMessage.schema.path('audio.publicId').options.select, false);
  });

  test('every status the inbox filters on is in the enum', () => {
    const allowed = ParentMessage.schema.path('status').enumValues;
    for (const status of PARENT_MESSAGE_STATUSES) {
      assert.ok(allowed.includes(status));
    }
    assert.ok(allowed.includes('new'));
    assert.ok(allowed.includes('resolved'));
  });
});

// ─────────────────────────────────────────────
// The audio upload boundary
// ─────────────────────────────────────────────
describe('parent messaging: audio acceptance', () => {
  test('the containers MediaRecorder actually emits are accepted', () => {
    // Not arbitrary `audio/*`: this is an unauthenticated endpoint, and the
    // alternative is uploading whatever subtype a caller names.
    assert.ok(PARENT_AUDIO_MIME_TYPES.includes('audio/webm'));
    assert.ok(PARENT_AUDIO_MIME_TYPES.includes('audio/webm;codecs=opus'));
    assert.ok(PARENT_AUDIO_MIME_TYPES.includes('audio/mp4'));
    assert.ok(PARENT_AUDIO_MIME_TYPES.includes('audio/ogg;codecs=opus'));
  });

  test('the Safari container is included', () => {
    // Safari has no WebM/Opus encoder. Without `audio/mp4` in the list the recorder
    // would work on Android Chrome and fail on every iPhone.
    assert.ok(PARENT_AUDIO_MIME_TYPES.includes('audio/mp4'));
  });

  test('a non-audio type is not on the list', () => {
    assert.ok(!PARENT_AUDIO_MIME_TYPES.includes('application/pdf'));
    assert.ok(!PARENT_AUDIO_MIME_TYPES.includes('image/png'));
  });
});

// ─────────────────────────────────────────────
// The inbox the bursar opens
// ─────────────────────────────────────────────
describe('parent messaging: inbox contract', () => {
  test('the list accepts the status tabs the page renders', () => {
    for (const status of ['all', 'new', 'read', 'resolved']) {
      const { error } = validate(listParentMessagesSchema, { status });
      assert.equal(error, undefined, `${status} should be a valid filter`);
    }
  });

  test('an unknown status is refused', () => {
    const { error } = validate(listParentMessagesSchema, { status: 'whatever' });
    assert.ok(error);
  });

  test('a non-ObjectId message id is refused', () => {
    const { error } = validate(parentMessageIdParamSchema, { id: 'not-an-id' });
    assert.ok(error);
  });

  test('resolving requires a note', () => {
    // A resolution with nothing written down is indistinguishable from an unanswered
    // message the next time the parent asks.
    const { error } = validate(resolveParentMessageSchema, {});
    assert.ok(error);
    assert.match(error.message, /what was done/i);
  });

  test('a real note is accepted', () => {
    const { error } = validate(resolveParentMessageSchema, {
      resolutionNote: 'Called and confirmed the cash payment; receipt issued.',
    });
    assert.equal(error, undefined);
  });
});

// ─────────────────────────────────────────────
// Route wiring — where the ad routes were wrong
// ─────────────────────────────────────────────
describe('route wiring', () => {
  /** Every path a router answers, by method. */
  const pathsFor = (router) => {
    const out = [];
    for (const layer of router.stack || []) {
      if (!layer.route) continue;
      out.push(...Object.keys(layer.route.methods).map((m) => `${m} ${layer.route.path}`));
    }
    return out;
  };

  test('the parent message routes are mounted', () => {
    const paths = pathsFor(parentMessageRoute);
    // No POST here by design. A message is created at `POST /pay/:token/notify-school`,
    // which is public and pay-token-scoped; adding a second authenticated way to
    // create one would let a staff member write a "parent message" that no parent
    // ever sent. The school's routes are read-and-answer only.
    for (const expected of [
      'get /parent-messages',
      'get /parent-messages/student/:studentId',
      'get /parent-messages/:id',
      'put /parent-messages/:id/read',
      'put /parent-messages/:id/resolve',
    ]) {
      assert.ok(paths.includes(expected), `missing route: ${expected}`);
    }
  });

  test('the school inbox paths are literal, not parameterised', () => {
    // A one-segment literal has to be declared before `/:id`, or Express captures the
    // word "student" as an id and the lookup fails its ObjectId pattern with a 422
    // naming a message instead of saying the route does not exist.
    const stack = parentMessageRoute.stack.filter((layer) => layer.route);
    const studentIndex = stack.findIndex((layer) => /:studentId/.test(layer.route.path));
    const idIndex = stack.findIndex((layer) => layer.route.path === '/parent-messages/:id');
    assert.ok(studentIndex !== -1 && idIndex !== -1);
    assert.ok(
      studentIndex < idIndex,
      '/parent-messages/student/:studentId must be declared before /parent-messages/:id'
    );
  });

  /**
   * Runs a route's middleware chain with a stub request and reports the first status
   * it produces, or `null` if the chain fell through without answering.
   */
  const firstStatus = (layer, role) =>
    new Promise((resolve) => {
      const req = { user: { role, _id: 'x', schoolId: 'y' }, query: {}, params: { id: 'z' } };
      const res = {
        status(code) {
          this.code = code;
          return this;
        },
        json(payload) {
          resolve({ code: this.code, payload });
        },
      };
      // Start after `authenticate`, whose job is done for a stub user, so the answer
      // is about authorisation alone.
      const chain = layer.route.stack.slice(1).map((entry) => entry.handle);
      const step = (index) => (error) => {
        if (error) return resolve({ code: null, error });
        const fn = chain[index];
        if (!fn) return resolve({ code: null });
        return fn(req, res, step(index + 1));
      };
      step(0)();
    });

  const inboxLayer = () =>
    parentMessageRoute.stack.filter((l) => l.route).find((l) => l.route.path === '/parent-messages');

  test('a bursar and an accountant can read the inbox', async () => {
    for (const role of ['school_admin', 'accountant', 'super_admin']) {
      const result = await firstStatus(inboxLayer(), role);
      assert.notEqual(result.code, 403, `${role} should be allowed to read parent messages`);
    }
  });

  test('a teacher cannot read the inbox', async () => {
    // `teacher` was in this guard, justified by "a class teacher is often who a parent
    // wants to reach". That does not survive contact with what the collection holds:
    // `ParentMessage.parentPhone` is stored in full because a bursar cannot return a
    // call without it, so allowing teachers to read it hands every teacher on the
    // staff the school's entire parent contact list — and does so from a module that
    // outlives the request, which is the reason the record exists at all.
    //
    // `findSchoolRecipients` already draws this line ("a teacher has no business
    // acting on a balance dispute"), so a role that is not alerted must not be able
    // to read the record either.
    const result = await firstStatus(inboxLayer(), 'teacher');
    assert.equal(result.code, 403, 'a teacher must not be able to read parent messages');
  });

  test('a viewer cannot read the inbox', async () => {
    const result = await firstStatus(inboxLayer(), 'viewer');
    assert.equal(result.code, 403, 'a viewer must not be able to read parent messages');
  });

  test('the ad moderation routes answer the paths the client calls', () => {
    // These were registered as `/schools/:id/settings…` — three segments — while
    // `services/admin.js` calls `/admin/school-ads`. `GET /api/admin/school-ads`
    // matched nothing and the Content queue answered "Route not found" in production
    // while working perfectly under VITE_USE_MOCKS.
    const paths = pathsFor(adminRoute);
    for (const expected of [
      'get /school-ads',
      'post /school-ads',
      'put /school-ads/:adId',
      'put /school-ads/:adId/approve',
      'delete /school-ads/:adId',
    ]) {
      assert.ok(paths.includes(expected), `missing route: ${expected}`);
    }
  });

  test('the old, wrong ad paths are gone', () => {
    // Kept as aliases would be how they drifted in the first place: two working paths
    // for one resource, and the next client has a coin flip with no test to catch it.
    //
    // Scoped to `/schools/:id/settings` rather than to `/settings` in general —
    // `GET /settings`, `PUT /settings` and the commission/disbursement branches are
    // platform-settings routes and have nothing to do with this.
    const paths = pathsFor(adminRoute);
    const stale = paths.filter((path) => path.includes('/schools/') && path.includes('/settings'));
    assert.deepEqual(stale, [], `stale ad paths still registered: ${stale.join(', ')}`);
  });

  test('the SMS top-up route is super-admin only', async () => {
    // It used to accept `school_admin` and `accountant`, so any bursar could mint
    // unlimited SMS credit for their own school with no payment and no approval. It
    // wrote a real SmsCreditTopUp row, so it looked like a purchase in every audit
    // and report while being free.
    const layer = (smsRoute.stack || [])
      .filter((entry) => entry.route)
      .find((entry) => entry.route.path === '/sms/credits/top-up');

    assert.ok(layer, 'the top-up route should exist');

    // Asserted by *running* the chain rather than by reading middleware names. The
    // authorize guard is an arrow returned from a factory, so it reaches `router.stack`
    // as `<anonymous>` and there is no name to match on — a test that looked for one
    // would fail against a correctly-wired route and pass against an unwired one.
    const run = (role) =>
      new Promise((resolve) => {
        const req = { user: { role, _id: 'x', schoolId: 'y' } };
        const res = {
          status(code) {
            this.code = code;
            return this;
          },
          json(payload) {
            resolve({ code: this.code, payload });
          },
        };
        // `authenticate` is index 0 and would reject the stub user; start after it so
        // the assertion is about authorisation alone.
        const chain = layer.route.stack.slice(1).map((entry) => entry.handle);
        const next = (index) => (error) => {
          if (error) return resolve({ code: null, error });
          const fn = chain[index];
          if (!fn) return resolve({ code: null });
          return fn(req, res, next(index + 1));
        };
        next(0)();
      });

    const denied = await run('school_admin');
    assert.equal(denied.code, 403, 'a school admin must not be able to mint SMS credit');

    const accountant = await run('accountant');
    assert.equal(accountant.code, 403, 'nor may an accountant');

    // A super admin must get *past* authorisation. It does not return `null` here:
    // the next middleware in the chain is `validate(topUpCreditsSchema)`, and the
    // stub body is empty, so a 422 is the correct and expected answer — and the fact
    // that it is a 422 rather than a 403 is precisely what proves the gate opened.
    const allowed = await run('super_admin');
    assert.notEqual(allowed.code, 403, 'a super admin must not be blocked by authorize()');
    assert.equal(allowed.code, 422, 'and should reach body validation instead');
  });
});