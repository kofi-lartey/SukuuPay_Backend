// Cross-root contract sync.
//
// The student-ID card now lives behind two contract files that cannot share a
// module path (the repo has separate `frontend/` and `Backend/` roots and no
// shared node_modules):
//
//   - frontend/src/components/students/idcards/cardContract.js  (JSX-free)
//   - Backend/src/utils/idCardContract.js
//
// Every colour, font role, typographic height, geometry constant and field
// resolver is meant to be identical in both. The two renderers (React preview
// and pdfkit sheets) both import their local twin, so a value that drifts in
// only *one* file is invisible to a single-root test run — it only surfaces as
// "the PDF doesn't match the preview". This test imports both twins into one
// process and deep-equals the shared surface so a typo in one is caught here.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import * as backend from '../src/utils/idCardContract.js';
import * as frontend from '../../frontend/src/components/students/idcards/cardContract.js';

const CARD_GEOMETRY_KEYS = ['widthMm', 'heightMm', 'cornerRadiusMm', 'bleedMm', 'safeMarginMm', 'printDpi'];
const COLOR_KEYS = ['body', 'muted', 'label', 'border', 'cardBg', 'headerRule', 'footerRule',
  'magStripe', 'magStripeText', 'magStripeBrand', 'brandBadge', 'brandBadgeText',
  'surfaceLight', 'qrBg'];
const TYPO_KEYS = ['name', 'field', 'label', 'body', 'footer', 'scan', 'magStripe', 'barcode', 'small'];

describe('ID card contract: backend and frontend are in lockstep', () => {
  test('CARD_GEOMETRY is identical', () => {
    for (const k of CARD_GEOMETRY_KEYS) {
      assert.equal(frontend.CARD_GEOMETRY[k], backend.CARD_GEOMETRY[k], `CARD_GEOMETRY.${k} drifted`);
    }
    assert.equal(backend.MM, frontend.MM, 'MM (points per mm) drifted');
  });

  test('COLORS are identical', () => {
    for (const k of COLOR_KEYS) {
      assert.equal(frontend.COLORS[k], backend.COLORS[k], `COLORS.${k} drifted`);
    }
  });

  test('TYPO scale is identical', () => {
    for (const k of TYPO_KEYS) {
      assert.equal(frontend.TYPO[k], backend.TYPO[k], `TYPO.${k} drifted`);
    }
  });

  test('the brand badge text is byte-for-byte identical', () => {
    assert.equal(frontend.BRAND_BADGE_TEXT, backend.BRAND_BADGE_TEXT, 'brand badge text drifted');
  });

  test('layoutFor() returns the same frames from both twins', () => {
    const f = frontend.layoutFor();
    const b = backend.layoutFor();
    assert.deepEqual(f, b, 'layoutFor() frames drifted between roots');
  });

  test('resolveCardData returns the same shape and values from both twins', () => {
    // A representative student + school that exercise every derived field:
    // motto, schoolCode, brandColor, academic year fallback, primary guardian,
    // first emergency contact, photo and QR.
    const student = {
      studentName: 'Ada Lovelace',
      studentId: 'PBS-2026-0001',
      studentClass: 'JHS 2A',
      dateOfBirth: new Date('2012-04-23'),
      studentImage: 'data:image/png;base64,abc',
      academicYear: '2025/2026',
      parents: [
        { parentName: 'Annie', phone: '0244000001' },
        { parentName: 'Augusta', phone: '0244000002', isPrimary: true },
      ],
      emergencyContacts: [{ contactName: 'Uncle Bob', phone: '0201000001' }],
    };
    const school = {
      name: 'Prampram Basic School',
      motto: 'Service Above Self',
      schoolCode: 'SC-001',
      brandColor: '#0A5C36',
      logo: 'data:image/png;base64,logo',
      academic: { currentYear: '2024/2025' },
    };

    const f = frontend.resolveCardData(student, school, { qrCodeUrl: 'data:image/png;base64,qr' });
    const b = backend.resolveCardData(student, school, { qrCodeUrl: 'data:image/png;base64,qr' });

    assert.deepEqual(f, b, 'resolveCardData drifted between roots');
  });

  test('the backend service helper uses the shared resolver (no hand-rolled subset)', () => {
    // buildCardData must delegate to idCardContract.resolveCardData, otherwise it
    // can silently omit a field the preview shows. We cannot import the service
    // without Mongoose wiring, but we can assert the contract exposes exactly the
    // keys buildCardData is expected to forward.
    // The contract test used to pin `brandColor` here. It is gone: the card is
    // monochrome, so no renderer reads a school brand colour any more. If a
    // colour ever comes back to the card it has to come back through here, with
    // both twins updated together.
    const contractKeys = new Set(Object.keys(backend.resolveCardData({ parents: [] }, {})));
    const expected = new Set([
    'schoolName', 'schoolLogo', 'schoolStamp', 'schoolMotto', 'schoolCode',
      'studentImage', 'studentName', 'studentId', 'dateOfBirth', 'studentClass',
      'academicYear', 'guardianName', 'guardianPhone', 'emergencyContact', 'qrCodeUrl',
    ]);
    assert.deepEqual([...contractKeys].sort(), [...expected].sort(),
      'resolveCardData field set changed without buildCardData being re-audited');
  });
});
