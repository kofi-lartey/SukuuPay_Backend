// Run with `npm test` from `Backend/`.
//
// ## `multer-storage-cloudinary@4` does not put `secure_url` on `req.file`
//
// It maps the Cloudinary response onto multer's own field names — `path` for the URL,
// `filename` for the public id (see `lib/index.js:107-111` of the installed package).
// Versions 1 and 2 merged the whole response, so `req.file.secure_url` used to exist.
//
// Code written against the old shape asks for a field that is **always** `undefined`, and
// `uploaded.secure_url || imageUrl` therefore discards every uploaded file and falls
// through to the pasted-URL branch. That is how `POST /admin/school-ads` answered
// *"An ad image is required"* to a request that had arrived complete — correct
// `content-type` with a boundary, every text field present, and the picture sitting on
// `req.file` where nothing was reading it. The identical bug in
// `schoolAdRequest.service.js` meant a school's own uploaded creative was saved with a
// null image.
//
// The second half is `extractPublicId`, which took only the first path segment after
// `/upload/vNNN/`. Every upload in this file sets a `folder`, so that segment was the
// bare folder name — `sukuuPay` — and every cleanup that used it to remove an orphaned
// asset was deleting a name that does not exist.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readUploaded, extractPublicId } from '../src/middleware/upload.js';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

const SECURE_URL =
  'https://res.cloudinary.com/demo/image/upload/v1757000000/sukuuPay/ads/school-ad-1757000000-123456789.webp';
const PUBLIC_ID = 'sukuuPay/ads/school-ad-1757000000-123456789';

describe('reading a multer file’s Cloudinary coordinates', () => {
  test('the v4 shape — path and filename', () => {
    // Exactly what `multer-storage-cloudinary@4` calls back with.
    const file = { fieldname: 'image', path: SECURE_URL, size: 48213, filename: PUBLIC_ID };
    assert.deepEqual(readUploaded(file), { url: SECURE_URL, publicId: PUBLIC_ID });
  });

  test('the pre-v4 shape — secure_url and public_id', () => {
    // Kept working deliberately: an upgrade that restores the merged response must not
    // turn every upload back into a no-op, and that failure mode is silent.
    const file = { fieldname: 'image', secure_url: SECURE_URL, bytes: 48213, public_id: PUBLIC_ID };
    assert.deepEqual(readUploaded(file), { url: SECURE_URL, publicId: PUBLIC_ID });
  });

  test('no file, and a file with neither shape', () => {
    assert.deepEqual(readUploaded(null), { url: null, publicId: null });
    assert.deepEqual(readUploaded(undefined), { url: null, publicId: null });
    assert.deepEqual(readUploaded({ fieldname: 'image', size: 1 }), { url: null, publicId: null });
  });

  test('the uploaded file wins over a pasted URL', () => {
    // Precedence, because it is the whole point: the old bug was that it never won.
    const file = { path: SECURE_URL, filename: PUBLIC_ID };
    const pasted = 'https://example.com/not-used.png';
    assert.equal(readUploaded(file).url || pasted, SECURE_URL);
  });
});

describe('extractPublicId keeps the folder', () => {
  test('a foldered URL yields the full public id', () => {
    // The regression. The old pattern captured one `[^/]+` segment — `sukuuPay` — which
    // is not a deletable asset, so every orphan cleanup silently kept its asset.
    assert.equal(extractPublicId(SECURE_URL), PUBLIC_ID);
  });

  test('an unfoldered URL still works', () => {
    assert.equal(
      extractPublicId('https://res.cloudinary.com/demo/image/upload/v1757000000/school-logo-1.png'),
      'school-logo-1'
    );
  });

  test('raw and video resource types', () => {
    assert.equal(
      extractPublicId('https://res.cloudinary.com/demo/raw/upload/v1757000000/sukuuPay/docs/a.pdf'),
      'sukuuPay/docs/a'
    );
    assert.equal(
      extractPublicId('https://res.cloudinary.com/demo/video/upload/v1757000000/sukuuPay/voice/note.mp4'),
      'sukuuPay/voice/note'
    );
  });

  test('the version segment is not part of the id', () => {
    // Cloudinary's `destroy` is given `sukuuPay/ads/x`, never `v1757000000/sukuuPay/ads/x`.
    const id = extractPublicId(SECURE_URL);
    assert.ok(!id.startsWith('v'), `public id must not carry the version: ${id}`);
    assert.equal(id, PUBLIC_ID);
  });

  test('nothing usable returns null rather than a partial id', () => {
    for (const input of [null, undefined, '', 'https://example.com/image.png']) {
      assert.equal(extractPublicId(input), null);
    }
  });
});

describe('no call site still reads the pre-v4 field names off a multer file', () => {
  // The assertion that actually holds the line. `readUploaded` existing is not enough —
  // one remaining `req.file.secure_url` anywhere re-creates a silent no-op upload.
  const offenders = [];

  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;

      // `readUploaded` is the one place allowed to know the shape — naming both
      // spellings is its entire job — so it is the single exclusion, and the assertion
      // below holds every *other* file to it.
      if (full === join(srcDir, 'middleware', 'upload.js')) continue;

      const source = readFileSync(full, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');

      // A multer file read directly for `secure_url` / `public_id`. Deliberately narrow:
      // `uploadResult.secure_url` and `result.secure_url` come from a direct
      // `cloudinary.v2.uploader` call in `utils/cloudinary.js`, which does return that
      // shape, and those are correct.
      for (const match of source.matchAll(/(?:req\.file|uploaded|file|req\.files\?\.\w+)\s*(\?\.|\.)\s*(secure_url|public_id)/g)) {
        offenders.push(`${full.replace(srcDir, 'src')}: ${match[0]}`);
      }
    }
  };

  walk(srcDir);

  assert.deepEqual(
    offenders,
    [],
    'a CloudinaryStorage multer file carries path/filename, not secure_url/public_id — use readUploaded()'
  );
});