// Run with `npm test` from `Backend/`.
//
// ## No mongoose hook may declare a `next` callback
//
// Mongoose 7 removed the callback argument from hooks. `kareem`, the hook library it
// uses, applies a pre-hook with only its own arguments —
// `pres[i].fn.apply(context, $args)` — so a `next` identifier inside a hook is
// `undefined` and calling it throws:
//
//     TypeError: next is not a function
//
// The failure is total and quiet at the wrong moment. The server boots, every other
// route works, health checks pass, and the document simply cannot be saved. On
// `ParentMessage` that meant **a parent's message was never recorded at all** — the row
// the school inbox reads did not exist — while the parent was shown
// `TypeError: next is not a function` on an unauthenticated pay link.
//
// Three models carried this: `ParentMessage`, `PlatformSmsPoolEntry` and
// `SmsPurchaseRequest`. The first is the one a member of the public can reach.
//
// Asserted two ways, because either alone can be satisfied by accident: the source must
// not declare the parameter, and the hook must actually run against the installed
// `kareem`. The second is the real proof — it fails on the installed library, so an
// upgrade that changes the rule is caught here rather than in a parent's browser.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import kareem from 'kareem';

import { ParentMessage } from '../src/models/ParentMessage.js';
import { PlatformSmsPoolEntry } from '../src/models/PlatformSmsPoolEntry.js';
import { SmsPurchaseRequest } from '../src/models/SmsPurchaseRequest.js';

const modelsDir = fileURLToPath(new URL('../src/models', import.meta.url));

/**
 * The `pre` hooks mongoose registered for one event on one model.
 *
 * Read off `model.hooks._pres`, which is kareem's own `Map` — mongoose 9 moved the hook
 * store onto the model and there is no public accessor for it. Read through a `Map` API
 * rather than property access because the store is not a plain object.
 */
const presOf = (model, event) => model.hooks?._pres?.get(event) || [];

/** Every registered pre-hook, across the events a save can run. */
const preHooksOf = (model) =>
  ['save', 'validate', 'findOneAndUpdate', 'updateOne', 'remove', 'deleteOne', 'insertMany']
    .flatMap((event) =>
      presOf(model, event).map((hook) => ({ event, fn: hook.fn, name: hook.fn.name || 'anonymous' }))
    );

describe('mongoose hooks do not declare a next callback', () => {
  test('kareem does not supply one — the reason the rule exists', async () => {
    // The mechanism, proven against the installed library rather than taken from a
    // changelog. If a future Mongoose restores the callback this test should be revisited
    // rather than left to fail.
    const hooks = new kareem();
    hooks.pre('save', function legacyStyle(next) {
      this.minted = true;
      next();
    });

    const context = {};
    await assert.rejects(
      () => hooks.execPre('save', context, [context]),
      /next is not a function/,
      'kareem is expected to withhold the callback — this is what the fix works around'
    );
  });

  test('a promise-style pre hook does run', async () => {
    // The positive half. Without it, "no hook declares next" would also be satisfied by
    // a model that registers no hooks at all.
    const hooks = new kareem();
    hooks.pre('save', function modernStyle() {
      this.minted = true;
    });

    const context = {};
    await hooks.execPre('save', context, [context]);
    assert.equal(context.minted, true);
  });

  test('no model in src/models declares a hook parameter', () => {
    const offenders = [];

    for (const file of readdirSync(modelsDir).filter((f) => f.endsWith('.js'))) {
      const source = readFileSync(join(modelsDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^[ \t]*\/\/.*$/gm, '');

      // `function name(next)` or an arrow taking `next` as its first parameter.
      const match = source.match(/\.pre\(\s*["'][\w.]+["']\s*,\s*(?:function\s*[\w$]*\s*\(\s*next\b|\(\s*next\b[^)]*\)\s*=>|next\s*=>)/);
      if (match) offenders.push(`${file}: ${match[0]}`);
    }

    assert.deepEqual(offenders, [], `hooks must not declare next: ${offenders.join('; ')}`);
  });

  test('no registered hook on any model declares next', () => {
    // The same rule against the *registered* functions rather than the source text, so a
    // hook built elsewhere — a plugin, a shared schema — is covered too.
    const models = [ParentMessage, PlatformSmsPoolEntry, SmsPurchaseRequest];
    const offenders = models.flatMap((model) =>
      preHooksOf(model)
        .filter((hook) => hook.fn.length > 0)
        .map((hook) => `${model.modelName} ${hook.event}:${hook.name}(…) declares ${hook.fn.length} parameter(s)`)
    );

    assert.deepEqual(
      offenders,
      [],
      'a pre-hook with parameters is called with its own arguments only, so `next` would be undefined'
    );
  });

  test('the three id-minting hooks actually mint', async () => {
    // Behavioural, per model, through the installed `kareem`. Each of these models can
    // only be written through its own hook, so a hook that no longer runs is a document
    // that cannot be saved — and a save that throws on the only path to persisting a
    // record is invisible until a member of the public reaches it.
    //
    // Run against a real document instance rather than a plain object: mongoose wraps
    // every registered hook so it can call document methods (`$getAllSubdocs` among them),
    // and the wrapper is what `execPre` invokes. A bare object as the context fails inside
    // the wrapper, which is a test artefact and not the behaviour under test.
    const cases = [
      [ParentMessage, 'messageId', /^PMSG-/],
      [PlatformSmsPoolEntry, 'entryId', /^POOL-/],
      [SmsPurchaseRequest, 'requestId', /^SMS-REQ-/],
    ];

    for (const [model, field, shape] of cases) {
      const minting = presOf(model, 'save').filter((hook) => /^mint/.test(hook.fn.name || ''));
      assert.equal(minting.length, 1, `${model.modelName} must have exactly one id-minting hook`);

      const doc = new model({});
      await model.hooks.execPre('save', doc, [doc]);
      assert.match(doc[field] || '', shape, `${model.modelName} did not mint ${field}`);
    }
  });

  test('a message already carrying an id keeps it', async () => {
    // The hook's other job. A retry of the same submission must not re-mint, or the
    // reference a parent was given stops matching the row.
    const doc = new ParentMessage({ messageId: 'PMSG-20260101-ABC123' });
    await ParentMessage.hooks.execPre('save', doc, [doc]);
    assert.equal(doc.messageId, 'PMSG-20260101-ABC123');
  });
});