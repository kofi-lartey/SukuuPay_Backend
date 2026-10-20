// ─────────────────────────────────────────────
// Payment reference generation
// ─────────────────────────────────────────────
// The reference the parent portal shows and polls on.
//
// `SUK-<epoch ms>-<6 chars>`: the timestamp makes it sortable and roughly unique,
// and the suffix removes the collision risk that a pure timestamp has — several
// parents can tap "Pay" in the same millisecond on a busy morning, and the
// initiating endpoint's rate limit is per token, so two *different* tokens can
// easily be initiated together.
//
// Uppercase alphanumerics only, because `payReferenceParamSchema` validates this
// exact shape and a lowercase generator would produce a reference the portal's
// own verify endpoint then rejects.
//
// It lives here rather than in `payment.service.js` because the plan-prepay path
// needs it too, and the two services already import each other.
import crypto from 'node:crypto';

export const generatePaymentReference = () => {
  const suffix = crypto
    .randomBytes(4)
    .toString('base64url')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .padEnd(6, 'X')
    .slice(0, 6);
  return `SUK-${Date.now()}-${suffix}`;
};

export default generatePaymentReference;
