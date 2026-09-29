// ─────────────────────────────────────────────
// Idempotency-Key replay protection
// ─────────────────────────────────────────────
// An unsafe POST (send a message, move money) that a client retries must not run
// twice. The Idempotency-Key header names the attempt; this module turns a
// repeat of that key into the original response instead of a second effect.
//
// Two rules make it safe:
//
//   1. Same key + same payload  → replay the stored response verbatim.
//   2. Same key + other payload → 409, because the client reused a key for a
//      different intent, and honouring either would be wrong.
//
// The record lives in its own TTL'd collection rather than on the resource it
// guards: a TTL on the resource would delete the audit trail.
import crypto from 'node:crypto';
import { IdempotencyRecord, IDEMPOTENCY_TTL_HOURS } from '../models/idempotencyModel.js';
import ApiError from './ApiError.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';

export const hashPayload = (payload) =>
  crypto.createHash('sha256').update(JSON.stringify(payload ?? null)).digest('hex');

/**
 * Returns a stored response for a replay, throws 409 when the same key is
 * reused with a different payload, and returns null when there is no record.
 * @param {string|null} key value of the Idempotency-Key request header
 */
export const checkIdempotency = async (key, scope, payload) => {
  if (!key) return null;

  const record = await IdempotencyRecord.findOne({ key, scope }).lean();
  if (!record) return null;

  if (record.requestHash !== hashPayload(payload)) {
    throw new ApiError(
      'This Idempotency-Key was already used with a different payload.',
      409,
      'IDEMPOTENCY_CONFLICT'
    );
  }

  return record.responseSnapshot;
};

export const rememberIdempotency = async (key, scope, payload, userId, responseSnapshot) => {
  if (!key) return;
  try {
    await IdempotencyRecord.create({
      key,
      scope,
      userId: userId || null,
      requestHash: hashPayload(payload),
      responseSnapshot,
      expiresAt: new Date(Date.now() + IDEMPOTENCY_TTL_HOURS * 60 * 60 * 1000),
    });
  } catch (error) {
    // A concurrent duplicate won the race; the key is already recorded.
    if (error?.code !== 11000) throw error;
  }
};

/** Reads the request's Idempotency-Key header, if the client sent one. */
export const idempotencyKeyFrom = (req) => req.get(IDEMPOTENCY_HEADER) || null;
