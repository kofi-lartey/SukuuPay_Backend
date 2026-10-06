// Run with `npm test` from `Backend/`.
//
// ## The public school-logos endpoint
//
// `GET /public/schools/logos` feeds the homepage logo carousel. It is
// unauthenticated, so the test pins the two things that make it safe:
//
//   1. **The projection is fixed.** `School` carries billing details
//      (`payment.bankAccount`) and gateway configuration. An
//      unauthenticated `lean()` without a `.select()` would return the
//      whole document. The handler must name exactly the three fields
//      the carousel needs — this is asserted against the source, because
//      the projection *is* the security control.
//   2. **The filter is closed.** Only active, un-deleted schools with a
//      logo are listed.
//
// Plus the wiring: the route is registered on the app's router tree, so
// a request actually reaches the handler.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import router from '../src/routes/index.js';
import { publicSchoolRoute } from '../src/routes/public.routes.js';

/** Every layer in the tree, flattened, with the path it was registered on. */
const layersOf = (node, prefix = '') => {
  const out = [];
  for (const layer of node.stack || []) {
    const routePath = `${prefix}${layer.route?.path || layer.path || ''}`;
    if (layer.route) {
      for (const entry of layer.route.stack) {
        out.push({
          method: Object.keys(layer.route.methods || {}).join(','),
          path: routePath,
          handler: entry.handle,
        });
      }
      continue;
    }
    if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...layersOf(layer.handle, routePath));
      continue;
    }
    out.push({ method: 'use', path: routePath, handler: layer.handle });
  }
  return out;
};

describe('the public school-logos route', () => {
  test('is registered on the app router', () => {
    const layers = layersOf(router);
    const logos = layers.filter(
      (layer) => layer.path.includes('/public/schools/logos') && layer.method.includes('get')
    );
    assert.ok(logos.length > 0, 'GET /public/schools/logos is not mounted');
  });

  test('is unauthenticated — no authenticate middleware on the router', () => {
    // The carousel is rendered by every visitor, including the logged-out
    // homepage. If an `authenticate` layer ever lands on this router, the
    // carousel silently breaks for the exact audience it exists for.
    const names = publicSchoolRoute.stack.map((layer) => layer.name || '');
    assert.ok(!names.includes('authenticate'), 'the public school route must stay unauthenticated');
  });
});

describe('the handler is safe to call without a session', () => {
  const source = readFileSync(
    new URL('../src/controllers/public.controller.js', import.meta.url),
    'utf8'
  );

  test('projects exactly name, logo and brandColor', () => {
    // The projection is the security control: it is what keeps
    // `payment.bankAccount` and the gateway configuration out of an
    // unauthenticated response. Asserted on the source because a test
    // that only checked the response shape would pass with a projection
    // that happened to be right today and was widened tomorrow.
    assert.match(source, /\.select\(\s*['"]name logo brandColor['"]\s*\)/);
    assert.ok(!source.includes('.populate('), 'an unauthenticated list must not populate');
  });

  test('filters to active, un-deleted schools that have a logo', () => {
    assert.match(source, /status:\s*['"]active['"]/);
    assert.match(source, /deletedAt:\s*null/);
    assert.match(source, /logo:\s*\{\s*\$ne:\s*null\s*\}/);
  });

  test('answers with a fixed envelope and never throws', () => {
    assert.match(source, /res\.status\(200\)\.json\(\{\s*success:\s*true,\s*schools:\s*\[\]\s*\}\)/);
    assert.match(source, /\.limit\(24\)/);
  });
});

describe('the public school-detail route', () => {
  test('is registered on the app router', () => {
    const layers = layersOf(router);
    const detail = layers.filter(
      (layer) => layer.path.includes('/public/schools/') && !layer.path.includes('logos') && layer.method.includes('get')
    );
    assert.ok(detail.length > 0, 'GET /public/schools/:schoolId is not mounted');
  });

  test('is unauthenticated — no authenticate middleware on the router', () => {
    const names = publicSchoolRoute.stack.map((layer) => layer.name || '');
    assert.ok(!names.includes('authenticate'), 'the public school route must stay unauthenticated');
  });

  test('the projection excludes sensitive fields', () => {
    const source = readFileSync(
      new URL('../src/controllers/public.controller.js', import.meta.url),
      'utf8'
    );
    assert.match(source, /\.select\(\s*['"]name logo brandColor address city region phone email website motto type yearFounded['"]\s*\)/);
    assert.ok(
      !source.includes('payment') || source.includes('payment:') === false,
      'the public school endpoint must not return payment details'
    );
  });

  test('answers 404 for a missing or deleted school', () => {
    assert.match(
      readFileSync(new URL('../src/controllers/public.controller.js', import.meta.url), 'utf8'),
      /return res\.status\(404\)/
    );
  });

  test('never throws — a broken detail card must not break the page', () => {
    const source = readFileSync(
      new URL('../src/controllers/public.controller.js', import.meta.url),
      'utf8'
    );
    assert.match(source, /res\.status\(200\)\.json\(\{\s*success:\s*false/);
  });
});
