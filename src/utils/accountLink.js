/**
 * The single definition of "is this account linked to a school?".
 *
 * This rule used to be implicit — the client inferred it from `schoolId === null`
 * and rendered a terminal "contact support" card. Inferred rules drift: the
 * frontend had no way to see the `super_admin` exception, and no way to see a
 * `schoolId` pointing at an archived school. Every consumer now reads the state
 * produced here instead, so the server stays the only authority.
 *
 * Consumers:
 *   - `authController.me`     → reported to the client as `onboarding`
 *   - `requireSchool`         → 409 SCHOOL_NOT_LINKED
 *   - `provisionSchoolForUser`→ decides between provisioning and idempotent return
 */

/** Reasons are stable strings; the client switches on `reason`, not on prose. */
export const LINK_REASONS = {
  ANONYMOUS: 'ANONYMOUS',
  PLATFORM_STAFF: 'PLATFORM_STAFF',
  UNLINKED: 'UNLINKED',
  LINKED: 'LINKED',
  DANGLING: 'DANGLING',
};

/**
 * `schoolExists` is optional and only consulted when `user.schoolId` is set: a
 * non-null id pointing at a soft-deleted school is a dangling reference, and
 * treating it as "linked" would send the user into steps that all fail with a
 * bare 403. Callers that cannot cheaply verify existence (the `me` hot path,
 * for instance) omit it and get the optimistic answer.
 *
 * @param {object|null} user
 * @param {(schoolId: string) => Promise<boolean>} [schoolExists]
 */
export const resolveAccountLinkState = async (user, schoolExists) => {
  if (!user) {
    return { linked: false, reason: LINK_REASONS.ANONYMOUS, schoolId: null };
  }

  // Platform staff legitimately belong to no school. Routing them into
  // provisioning would ask the founder to invent a school in order to use the
  // platform, which is why this check precedes the `schoolId` check.
  if (user.role === 'super_admin') {
    return { linked: true, reason: LINK_REASONS.PLATFORM_STAFF, schoolId: null };
  }

  if (!user.schoolId) {
    return { linked: false, reason: LINK_REASONS.UNLINKED, schoolId: null };
  }

  if (schoolExists) {
    const alive = await schoolExists(String(user.schoolId));
    if (!alive) {
      return { linked: false, reason: LINK_REASONS.DANGLING, schoolId: null };
    }
  }

  return { linked: true, reason: LINK_REASONS.LINKED, schoolId: String(user.schoolId) };
};

export default resolveAccountLinkState;
