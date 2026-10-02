import {
  listAnnouncements,
  getAnnouncement,
  createAnnouncement,
  updateAnnouncement,
  deactivateAnnouncement,
} from "../../services/admin/announcements.service.js";

/**
 * Announcement endpoints for the platform console.
 *
 * Five handlers, and not one of them contains a rule. Audience/target
 * consistency, the `endsAt > startsAt` window check, the 500-recipient cap and
 * every other business decision live in
 * `services/admin/announcements.service.js`; what remains here is the transport.
 *
 * **Every handler catches and answers. None of them calls `next(error)`.** Express
 * 5 supports async handlers but does *not* auto-forward a rejection, so a
 * handler that throws past its own `catch` produces a request that never
 * completes rather than an error response — the client hangs until it times out,
 * and the failure looks like a network problem instead of the bad input that
 * caused it. `res.status(...)` is always `return`ed for the same reason: an
 * unretained `res` falls through to the rest of the function, and a handler that
 * logs or reshapes after responding writes headers twice.
 *
 * The audit entries are written **inside the service**, not here, on purpose.
 * `auditService.log` swallows its own failures (`utils/auditService.js:46`) so
 * that a logging outage cannot roll back a business operation — which means an
 * audit write that happens after the response is sent is an audit write that may
 * never happen at all. Awaiting it before answering is the only ordering in which
 * "the caller got a 201, therefore the entry exists" is true.
 */

/**
 * GET /admin/announcements
 *
 * `active=true` returns only what is live *right now*, which is a stricter filter
 * than "not switched off" — it also excludes anything scheduled for later and
 * anything whose window has closed. See `listAnnouncements` for the exact
 * translation of `isAnnouncementLive` into a Mongo filter, including why
 * `endsAt` is matched with `$gt` rather than `$gte`.
 */
export const listAnnouncementsController = async (req, res) => {
  try {
    const { announcements, meta } = await listAnnouncements(req.query);

    return res.status(200).json({
      success: true,
      message: "Announcements retrieved successfully",
      data: announcements,
      meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * GET /admin/announcements/:id
 *
 * Returns inactive notices too. A console that could only read live notices
 * could not answer "what did we publish last Tuesday" — and the
 * deactivate-rather-than-delete rule is worthless without a way to read the row
 * it preserved.
 */
export const getAnnouncementController = async (req, res) => {
  try {
    const result = await getAnnouncement(req.params.id);

    return res.status(200).json({
      success: true,
      message: "Announcement retrieved successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * POST /admin/announcements
 *
 * Three of the four refusals are 422s from the validation layer (title/body/
 * startsAt missing, or the 2000-character body cap) and one is a 400 from the
 * service: the audience/target inversion. They are deliberately not folded
 * together — `targetSchoolIds` on an `all_schools` notice is a *contradiction in
 * the request* rather than a malformed one, and the message says so.
 */
export const createAnnouncementController = async (req, res) => {
  try {
    const result = await createAnnouncement(req.body, req.user, req);

    return res.status(201).json({
      success: true,
      message: "Announcement created successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * PUT /admin/announcements/:id
 *
 * A patch. The success message reports whether anything actually changed, so a
 * console can distinguish "saved" from "you submitted the same document again" —
 * the second writes no audit entry, and telling the operator it did would be
 * claiming a trail that was not created.
 */
export const updateAnnouncementController = async (req, res) => {
  try {
    const { announcement, changedFields } = await updateAnnouncement(
      req.params.id,
      req.body,
      req.user,
      req
    );

    return res.status(200).json({
      success: true,
      message: changedFields.length
        ? "Announcement updated successfully"
        : "No changes to save",
      data: { ...announcement, changedFields },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

/**
 * DELETE /admin/announcements/:id — withdraw, not erase.
 *
 * The HTTP verb is DELETE because the operator's intent is "stop showing this",
 * and because a console's destructive-action affordance keys off the verb. What
 * it does is set `isActive: false`. The row survives: a notice a school was shown
 * cannot be un-shown, and this is the record that it ever was.
 *
 * 200 rather than 204 — there is a meaningful body here (`isActive: false`,
 * `wasLiveAtWithdrawal`), and a 204 would discard the one fact an operator
 * withdrawing a live banner during an outage most needs: whether it *was* live.
 */
export const deactivateAnnouncementController = async (req, res) => {
  try {
    const { announcement, wasLiveAtWithdrawal } = await deactivateAnnouncement(
      req.params.id,
      req.user,
      req
    );

    return res.status(200).json({
      success: true,
      message: "Announcement withdrawn successfully",
      data: { ...announcement, wasLiveAtWithdrawal },
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};