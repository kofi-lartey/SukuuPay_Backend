import { resolveAccountLinkState } from '../utils/accountLink.js';

/**
 * Rejects school-scoped requests from an account with no usable school.
 *
 * Without this, every service answers the same situation differently: some
 * compare `requester.schoolId?.toString() !== schoolId` and return a bare
 * `403 You do not have access to this school` (school.service.js:135), which is
 * indistinguishable from "you are a different school's bursar". For a brand-new
 * admin that message is wrong in the most confusing way possible — they own
 * nothing yet, so nothing is denied to them; they simply have nothing to act on.
 *
 * The response is therefore explicit and actionable: a machine-readable code the
 * client routes on, and an `action` naming the product surface that fixes it.
 */
export const requireSchool = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ success: false, message: 'Authentication required' });
  }

  const state = await resolveAccountLinkState(req.user);

  if (!state.linked) {
    return res.status(409).json({
      success: false,
      message: 'Set up your school profile to continue.',
      code: 'SCHOOL_NOT_LINKED',
      action: 'PROVISION_SCHOOL',
      reason: state.reason,
    });
  }

  req.linkState = state;
  return next();
};

export default requireSchool;
