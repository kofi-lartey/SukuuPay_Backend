// Regression suite for the profile-picture upload: `POST /upload/avatar` and
// `DELETE /upload/avatar`.
//
//   npm test
//
// The behaviour this exists to protect:
//
//   1. The avatar endpoint is authenticated and **not** `authorize`-gated, which
//      is the whole point of it. Every other route in `upload.routes.js` is
//      `requireSchoolAdmin`, because everything else there changes something that
//      belongs to a school. A profile picture belongs to the account, so a
//      teacher setting their own face must not be a school-admin action — and
//      the one sure way to get that wrong is to copy the neighbouring route.
//   2. It stays a self-service endpoint: the subject is the session, never a
//      request parameter, so there is no id to swap.
//   3. A rejected picture is a 4xx with a message the teacher can act on, not a
//      500 with "something went wrong" about a file they can plainly see is too
//      big.
//   4. Replacing a picture cannot cost the teacher the old one.
//
// Pure unit tests, no database and no Cloudinary: the routes are driven through
// their middleware stack, the 4xx wrapper is exercised with a stub, and the
// service contract is read from the source the way `platformSettings.test.js`
// reads the provisioning call.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { uploadRoute } from '../src/routes/upload.routes.js';
import { avatarUploadRoute, asClientErrors } from '../src/middleware/upload.js';
import { uploadUserAvatar } from '../src/services/upload.service.js';

const mountFor = (method, path) =>
  uploadRoute.stack.find((layer) => layer.route?.path === path && layer.route.methods[method]);

/**
 * Walks a route's middleware stack the way Express would, with a session, and
 * reports the first refusal.
 *
 * `authenticate` is skipped rather than satisfied: with no bearer token it
 * answers 401, which is a *different* refusal from a role refusal and must not
 * be mistaken for one. The controller is the last layer and is skipped too — it
 * touches the database and Cloudinary, and reaching it is exactly the "this
 * caller was allowed through" signal these tests want.
 *
 * `headers` carries a non-multipart content type, which is what lets the multer
 * wrapper short-circuit on a request with no file and call `next()` rather than
 * trying to parse a body that is not there. Without it the walk crashes on
 * multer's own stream handling, which is a fact about the harness, not about the
 * route.
 *
 * @returns {{ status: number|null }} null when nothing refused the caller.
 */
const gateFor = (routeLayer, role) => {
  const req = {
    user: { _id: 'caller', role, schoolId: 'sch1' },
    params: {},
    body: {},
    headers: { 'content-type': 'application/json' },
  };

  for (const entry of routeLayer.route.stack.slice(0, -1)) {
    if (entry.name === 'authenticate') continue;

    const answer = { status: null };
    const res = {
      status(code) {
        answer.status = code;
        return this;
      },
      json(body) {
        answer.code = body?.code;
        answer.message = body?.message;
        return this;
      },
    };

    entry.handle(req, res, () => {});
    if (answer.status !== null) return { status: answer.status };
  }

  return { status: null };
};

describe('POST /upload/avatar', () => {
  test('is mounted with the upload middleware between the session and the controller', () => {
    const layer = mountFor('post', '/avatar');
    assert.ok(layer, 'POST /upload/avatar is not mounted');

    const stack = layer.route.stack;
    const handles = stack.map((entry) => entry.handle);

    // Identity rather than a name: a multer layer is an anonymous function, so
    // `entry.name` is '' and a name assertion would pass on nothing at all.
    assert.ok(
      handles.includes(avatarUploadRoute),
      'avatarUploadRoute is missing — the route would accept a request with no file'
    );
    assert.ok(
      handles.indexOf(avatarUploadRoute) < stack.length - 1,
      'the upload middleware sits after the controller and would parse nothing'
    );
  });

  test('every school role may set their own picture', () => {
    // A teacher is the subject of their own profile picture, and they are the
    // reason this endpoint exists. An `authorize("school_admin")` copy-pasted
    // from the neighbouring routes would make it unreachable to them.
    const layer = mountFor('post', '/avatar');

    for (const role of ['teacher', 'accountant', 'viewer', 'school_admin']) {
      assert.equal(gateFor(layer, role).status, null, `${role} was refused`);
    }
  });

  test('a platform owner may set theirs too, with no school in scope', () => {
    // `requireSchool` would 409 them: a `super_admin` legitimately has no
    // school. Another reason this route is not `requireSchool` + `authorize`.
    assert.equal(gateFor(mountFor('post', '/avatar'), 'super_admin').status, null);
  });

  test('still demands a session', () => {
    const names = mountFor('post', '/avatar').route.stack.map((entry) => entry.name);
    assert.ok(names.includes('authenticate'), 'authenticate is missing');
  });

  test('is the only upload route that is not admin-gated', () => {
    // The neighbours are all `requireSchoolAdmin`, and this one deliberately is
    // not. Stated as a behavioural difference rather than a middleware *name*,
    // because `authorize("super_admin", "school_admin")` returns an anonymous
    // arrow — `entry.name` is `''`, and a name assertion would pass on nothing
    // at all, which is how the first version of this test silently proved the
    // wrong thing.
    const teacherRefusedElsewhere = gateFor(mountFor('post', '/school-logo'), 'teacher');
    assert.equal(
      teacherRefusedElsewhere.status,
      403,
      'the school logo route no longer refuses a teacher'
    );

    assert.equal(
      gateFor(mountFor('post', '/avatar'), 'teacher').status,
      null,
      'the avatar route grew a school-admin gate'
    );
  });
});

describe('DELETE /upload/avatar', () => {
  test('is mounted, authenticated, and ungated', () => {
    const layer = mountFor('delete', '/avatar');
    assert.ok(layer, 'DELETE /upload/avatar is not mounted');

    const names = layer.route.stack.map((entry) => entry.name);
    assert.ok(names.includes('authenticate'), 'authenticate is missing');

    for (const role of ['teacher', 'accountant', 'viewer', 'school_admin', 'super_admin']) {
      assert.equal(gateFor(layer, role).status, null, `${role} was refused`);
    }
  });

  test('does not take an id, so nobody else\u2019s picture can be named', () => {
    // Bare `/avatar`, not `/avatar/:userId`. The target is the session; a
    // parameter would be somewhere for a caller to point at somebody else.
    assert.equal(mountFor('delete', '/avatar').route.path, '/avatar');
    assert.equal(mountFor('post', '/avatar').route.path, '/avatar');
  });
});

// ── A rejected picture is a 4xx, not a 500 ──────────────────────────────────
describe('the upload middleware answers in the 4xx range', () => {
  /**
   * Drives a wrapper whose inner middleware reports `error`, and reports what the
   * wrapper handed to `next`.
   *
   * `asClientErrors` does not answer the request itself — it stamps `.status` on
   * the error and forwards it, and the central `errorHandler` turns that into the
   * response. So the contract under test is the delegated error, and asserting on
   * `res.status` here would be asserting on a handler that is not in this layer.
   */
  const runWith = (error) =>
    new Promise((resolve) => {
      const middleware = asClientErrors((req, res, next) => next(error));
      const res = { status: () => res, json: () => resolve({ answered: true }) };
      middleware({ headers: {} }, res, (forwarded) => resolve({ forwarded }));
    });

  test('an oversized file is a 413 the client can name', async () => {
    // Multer's own limit error carries no `.status`. Unstamped, it becomes a 500
    // "Something went wrong" — a message about a file the teacher can plainly
    // see is too big.
    const { forwarded } = await runWith(
      Object.assign(new Error('File too large'), { code: 'LIMIT_FILE_SIZE' })
    );

    assert.ok(forwarded, 'the wrapper swallowed the error instead of reporting it');
    assert.equal(forwarded.status, 413, `expected 413, got ${forwarded.status}`);
    assert.equal(forwarded.message, 'File too large');
  });

  test('a wrong-format file is a 400 with the reason intact', async () => {
    // The filter's message is written for the uploader, and must survive rather
    // than being replaced by "invalid file".
    const { forwarded } = await runWith(new Error('Only JPG, PNG, and WebP images are allowed'));

    assert.equal(forwarded.status, 400);
    assert.equal(forwarded.message, 'Only JPG, PNG, and WebP images are allowed');
  });

  test('a request with no error passes straight through', async () => {
    const answer = await new Promise((resolve) => {
      const middleware = asClientErrors((req, res, next) => next());
      const res = { status: () => res, json: () => resolve({ answered: true }) };
      middleware({ headers: {} }, res, (err) => resolve({ err }));
    });

    assert.equal(answer.err, undefined, 'the wrapper forwarded a clean request as an error');
  });

  test('the mounted route uses the wrapped middleware, not the raw multer', () => {
    // The raw instance forwards with no status, which is the 500 this whole
    // suite is guarding against.
    assert.ok(
      mountFor('post', '/avatar').route.stack.some((entry) => entry.handle === avatarUploadRoute),
      'the route mounts the raw avatarUpload instead of avatarUploadRoute'
    );
  });
});

// ── The service, exercised where it is reachable without a database ─────────
describe('uploadUserAvatar rejects a file before touching Cloudinary', () => {
  // These rules throw before any sharp or Cloudinary call, so they are testable
  // for real: the fake user is never saved and no network is opened.
  const user = { avatar: null, save: async () => { throw new Error('must not save') } };

  test('refuses no file at all', async () => {
    await assert.rejects(() => uploadUserAvatar(null, user), (err) => err.code === 'NO_FILE');
  });

  test('refuses a non-image', async () => {
    await assert.rejects(
      () => uploadUserAvatar({ mimetype: 'application/pdf', buffer: Buffer.alloc(16) }, user),
      (err) => err.code === 'INVALID_MIME' && err.status === 400
    );
  });

  test('refuses an oversized image', async () => {
    await assert.rejects(
      () => uploadUserAvatar({ mimetype: 'image/png', buffer: Buffer.alloc(3 * 1024 * 1024) }, user),
      (err) => err.code === 'FILE_TOO_LARGE' && err.status === 400
    );
  });

  test('accepts every format the picker will offer', async () => {
    // The client offers jpg/png/webp. If the service were narrower, a teacher
    // would get "invalid" about a picture they chose from the dialog this
    // feature opened itself — so the three formats must pass the MIME gate.
    for (const mimetype of ['image/jpeg', 'image/png', 'image/webp']) {
      await assert.rejects(
        () => uploadUserAvatar({ mimetype, buffer: Buffer.alloc(8) }, user),
        // Past the MIME and size gates, so the next complaint is about the
        // picture's *dimensions* — a different error, which proves the format
        // was accepted.
        (err) => err.code === 'IMAGE_TOO_SMALL' || err.code === 'INVALID_IMAGE',
        `${mimetype} was rejected before the dimension check`
      );
    }
  });
});

// ── The replacement order, read rather than executed ────────────────────────
describe('replacing a picture cannot cost the old one', () => {
  const readSource = async () => {
    const { readFile } = await import('node:fs/promises');
    return readFile(new URL('../src/services/upload.service.js', import.meta.url), 'utf8');
  };

  test('reads the old asset before writing, and destroys it only afterwards', async () => {
    // The bug this prevents is the one `uploadStudentPhoto` already had: clearing
    // `avatar` and saving *before* the upload means a Cloudinary outage leaves
    // the account with no picture and nothing behind the old URL — permanent,
    // from a request the user was told had merely failed.
    const source = await readSource();
    const body = source.slice(
      source.indexOf('export const uploadUserAvatar'),
      source.indexOf('export const removeUserAvatar')
    );

    const readIndex = body.indexOf('extractPublicId(user.avatar)');
    const saveIndex = body.indexOf('user.avatar = avatarUrl');
    const destroyIndex = body.indexOf('deleteFromCloudinary(oldPublicId)');

    assert.ok(readIndex !== -1, 'the old public id is never read');
    assert.ok(saveIndex !== -1, 'the record is never written');
    assert.ok(destroyIndex !== -1, 'the old asset is never destroyed');
    assert.ok(readIndex < saveIndex, 'the record is written before the old id is read');
    assert.ok(saveIndex < destroyIndex, 'the old asset is destroyed before the record is saved');
  });

  test('crops to a square rather than serving the original', async () => {
    // Avatars render at 40–96 px in a circle. An uncropped 4000×3000 phone
    // portrait is both a wasted upload and a wrong-shaped face.
    const source = await readSource();
    const body = source.slice(source.indexOf('export const uploadUserAvatar'));

    assert.ok(body.includes('resize(256, 256'), 'the avatar is not cropped to a square');
    assert.ok(body.includes('fit: "cover"'), 'the crop is not a cover crop');
  });

  test('takes the user, not an id, so the subject cannot be swapped', async () => {
    // `uploadUserAvatar(req.file, req.user)`. Taking an id would make the
    // endpoint able to set somebody else's picture, which is the one thing it
    // must never do.
    const { readFile } = await import('node:fs/promises');
    const controller = await readFile(
      new URL('../src/controllers/upload.controller.js', import.meta.url),
      'utf8'
    );

    assert.ok(
      controller.includes('uploadUserAvatar(req.file, req.user)'),
      'the controller must pass the session user, not an id from the request'
    );
    assert.ok(
      !/req\.params\.userId/.test(controller),
      'the controller must not read a user id from the request'
    );
  });
});
