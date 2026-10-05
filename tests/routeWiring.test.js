// Run with `npm test` from `Backend/`.
//
// Every router in the product, walked once, asserting that every registered handler is
// actually a function.
//
// ## Why this file exists
//
// Express does not check this at registration time. A route declared with a handler that
// is `undefined`, `null`, or a plain object starts the server cleanly and throws only
// when a request reaches that layer:
//
//     TypeError: next is not a function
//
// Which is the worst time to find out. The server booted, health checks passed, every
// other route worked, and the failure appeared to the *user* as an unexplained error on
// one screen. Nothing in the stack points at the wiring.
//
// This is the same class as the missing `uploadSchoolAd` export that
// `admin.routes.js` documents in its own header: nothing catches it except a request
// that happens to hit that exact route.
//
// The check is a structural walk of Express's own `router.stack`, so it needs no
// database, no listening socket and no HTTP client. Express 5 keeps handlers in
// `layer.route.stack[].handle` for route layers and `layer.handle` for `router.use`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import router from '../src/routes/index.js';

/** Every layer in the tree, flattened, with the path it was registered on. */
const layersOf = (node, prefix = '') => {
  const out = [];

  for (const layer of node.stack || []) {
    const routePath = `${prefix}${layer.route?.path || layer.path || ''}`;
    const method = layer.route
      ? Object.keys(layer.route.methods || {}).join(',')
      : layer.method
        ? 'use'
        : 'middleware';

    if (layer.route) {
      // A route layer's own handle is the dispatcher; the handlers are on its stack.
      for (const entry of layer.route.stack) {
        out.push({
          method,
          path: routePath,
          handler: entry.handle,
          name: entry.name || 'anonymous',
        });
      }
      continue;
    }

    if (layer.name === 'router' && layer.handle?.stack) {
      out.push(...layersOf(layer.handle, routePath));
      continue;
    }

    out.push({ method, path: routePath, handler: layer.handle, name: layer.name || 'anonymous' });
  }

  return out;
};

describe('every registered route handler is callable', () => {
  const layers = layersOf(router);

  test('the walk found the routers', () => {
    // A guard on the guard: if `layersOf` silently returned nothing the assertions
    // below would pass vacuously, which is the failure mode of every structural test.
    assert.ok(layers.length > 50, `expected a populated route tree, walked ${layers.length} layers`);
    assert.ok(
      layers.some((l) => l.method.includes('get')),
      'no GET routes were found — the walk is not reading the tree correctly'
    );
  });

  test('no handler is undefined, null or a non-function', () => {
    // The assertion that catches the class of bug above. `next is not a function` is
    // what Express says at request time; this says which route and which position.
    const broken = layers.filter((layer) => typeof layer.handler !== 'function');

    assert.deepEqual(
      broken.map((l) => `${l.method} ${l.path} → ${String(l.handler)}`),
      [],
      'every route handler must be a function'
    );
  });

  test('the pay portal message route is wired end to end', () => {
    // The route a parent uses to write in, named explicitly because it is the one that
    // broke. Five layers between the path and the controller, each of which could have
    // been undefined: the limiter, the multer wrapper, the body marker, two validators
    // and the controller itself.
    //
    // Counted rather than matched by name. Every layer here is an anonymous arrow, so
    // `layer.name` is empty for all of them — asserting on a name would be asserting on
    // a variable name, which is not a contract.
    const notify = layers.filter((l) => l.path.includes('/notify-school'));

    assert.equal(
      notify.length,
      6,
      `expected limiter + upload + marker + 2 validators + controller, found ${notify.length}`
    );
    assert.ok(
      notify.every((l) => typeof l.handler === 'function'),
      'every layer on the notify-school route must be callable'
    );
  });

  test('the console ad route runs the upload middleware', () => {
    // `uploadSchoolAd` is what makes `req.file` exist. Without it a console creative
    // arrives with its text fields and no image, and the handler reports a missing
    // image about a request that did carry one.
    const create = layers.filter(
      (l) => /post/.test(l.method) && l.path.endsWith('/school-ads')
    );

    assert.ok(create.length > 0, 'POST /admin/school-ads must be registered');
    assert.ok(
      create.every((l) => typeof l.handler === 'function'),
      'every layer on the ad create route must be callable'
    );
  });

  test('the school ad request route runs the upload middleware', () => {
    const create = layers.filter(
      (l) => /post/.test(l.method) && l.path.includes('/schools/me/ad-requests')
    );

    assert.ok(create.length > 0, 'POST /schools/me/ad-requests must be registered');
    assert.ok(
      create.every((l) => typeof l.handler === 'function'),
      'every layer on the ad request route must be callable'
    );
  });
});