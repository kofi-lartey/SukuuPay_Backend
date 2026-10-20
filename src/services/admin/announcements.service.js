import mongoose from "mongoose";
import {
  PlatformAnnouncement,
  isAnnouncementLive,
} from "../../models/PlatformAnnouncement.js";
import ApiError from "../../utils/ApiError.js";
import { logRequest as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import {
  resolvePagination,
  buildMeta,
  optionalId,
  toObjectIdList,
} from "../../utils/platformQuery.js";

/**
 * Platform announcements — the notices SukuuPay publishes *to* schools.
 *
 * Everything the console needs for them lives in these five functions, and two
 * decisions are worth stating before the code rather than inside it.
 *
 * **Deletion is deactivation, and that is not a softening of the requirement.**
 * `DELETE /admin/announcements/:id` sets `isActive: false` and writes an
 * `admin.announcement_delete` entry. The model has no `deletedAt` and this
 * service never calls `findOneAndDelete`. Two things make a hard delete the wrong
 * tool here, and both are about other people's memory rather than the database's
 * tidiness:
 *
 *   - **A notice a school was shown cannot be un-shown.** If the school banner
 *     said "payments will be down on Saturday 02:00–06:00" and the operator
 *     deletes the row, the school's record of that promise is now a 404. The
 *     platform cannot distinguish "we withdrew this" from "this never existed",
 *     and a school that acted on it — told a parent the system would be down —
 *     has been actively misled by an operator's tidy-up.
 *   - **The published history is the audit trail.** "Was this notice about the
 *     gateway outage ever published, to whom, and who took it down?" is a question
 *     support will ask during the *next* outage. A hard delete destroys the only
 *     record that it was ever live, at exactly the moment somebody needs it.
 *
 * The model already draws the distinction this depends on: `isActive` is the
 * manual switch, separate from the `startsAt`/`endsAt` window, precisely so that
 * withdrawing a notice is an edit to one boolean rather than a rewrite of dates
 * (`PlatformAnnouncement.js:117-127`). Deactivation is that switch.
 *
 * **The live test is `isAnnouncementLive`, never a second copy of it.** The
 * model's helper treats `endsAt` as *exclusive*, so a notice whose window closed
 * at 09:00 is not live at 09:00 — inclusive would let two adjacent windows both
 * claim that instant. `listAnnouncements({ active: true })` translates that
 * predicate into a Mongo query, and the translation is the one place a
 * hand-written `startsAt <= now && endsAt > now` could disagree with the helper
 * the per-school banner query uses. It is spelled out below, field by field, for
 * that reason.
 */

/**
 * The impersonation attribution required on every audit entry written by this
 * service.
 *
 * `middleware/impersonation.js:227` refuses writes while impersonating, so on
 * these routes this is defence in depth rather than the primary mechanism — and
 * that is the right kind of defence in depth, because it keeps holding if
 * somebody later allowlists one of these paths without thinking about it. A
 * super admin who writes through somebody's session must be attributable to that
 * session, or the trail shows the impersonated account doing a platform-wide
 * thing, which is exactly the ambiguity the impersonation feature exists to
 * prevent.
 */
const impersonationMeta = (req) =>
  req?.impersonation
    ? {
        impersonatedBy: String(req.impersonation.superAdminId),
        impersonationSessionId: String(req.impersonation.sessionId),
      }
    : {};

/**
 * The fields worth keeping on both sides of an audit entry.
 *
 * Not the whole document. `PlatformAnnouncement` has no `select: false` fields
 * today, so a naive `{ before: doc }` is presently safe — but it is safe by
 * accident, and the first secret-shaped field added to this model would then be
 * copied into an audit row that the audit-log CSV exports verbatim
 * (`services/admin/auditLogs.service.js`). An explicit allowlist makes that
 * impossible rather than unlikely.
 *
 * `updatedAt` and `__v` are excluded for the reason documented at
 * `admin.service.js:495-502`: they are bookkeeping, and an entry that reads
 * `severity: info → critical, updatedAt: …` buries the change anybody is
 * actually looking for.
 */
const ANNOUNCEMENT_AUDIT_FIELDS = [
  "title",
  "body",
  "severity",
  "targetAudience",
  "targetSchoolIds",
  "startsAt",
  "endsAt",
  "isActive",
];

const snapshot = (doc) => {
  if (!doc) return null;
  const out = {};
  for (const field of ANNOUNCEMENT_AUDIT_FIELDS) {
    const value = doc[field];
    // `targetSchoolIds` is an array of ObjectIds; `String()`ing them makes the
    // stored entry readable in the CSV export, where an ObjectId would render as
    // a hex blob nobody can scan.
    out[field] = Array.isArray(value) ? value.map((id) => String(id)) : value ?? null;
  }
  return out;
};

/**
 * Rejects a payload whose audience and target list contradict each other.
 *
 * The rule is an inversion, and it is worth reading twice because it is the
 * opposite of what "allow targeting" would suggest:
 *
 *   - `selected_schools` **requires** a non-empty `targetSchoolIds`.
 *   - `all_schools` and `all_admins` **forbid** it outright.
 *
 * The reason is that `targetSchoolIds` is only ever consulted when the audience
 * is `selected_schools`. For the other two it is inert: `all_schools` resolves to
 * every active school and `all_admins` to every active school's admins, and
 * neither query ever looks at the list. Storing it anyway would leave a document
 * that *claims* a targeting which does not exist — an operator reading
 * `targetAudience: "all_schools"` alongside a three-school id list has no way to
 * tell whether those three schools were an additional filter or a leftover from
 * an earlier edit. A stored field that is silently ignored is worse than a
 * rejected one, because it answers a question with the wrong answer.
 *
 * 400 rather than 422: 422 is owned by the validation layer (see
 * `middleware/validate.js:46`), and the Joi schemas deliberately do *not*
 * express this rule — see the note on `createAnnouncementSchema`. The check needs
 * to compare the audience against the merged document, not against one request,
 * and an explanation beats a bare `"targetSchoolIds is not allowed"` here.
 */
const assertAudienceConsistent = (targetAudience, targetSchoolIds) => {
  const ids = Array.isArray(targetSchoolIds) ? targetSchoolIds : [];

  if (targetAudience === "selected_schools") {
    if (!ids.length) {
      throw new ApiError(
        "targetAudience is \"selected_schools\", so targetSchoolIds must name at least one school. An audience of \"selected\" with no selection is \"all\", written in a form that reads as a narrower scope than it is.",
        400,
        "TARGET_SCHOOLS_REQUIRED"
      );
    }
    return;
  }

  if (ids.length) {
    throw new ApiError(
      `targetSchoolIds is only read when targetAudience is "selected_schools". Storing it with targetAudience "${targetAudience}" would record a targeting that no read path consults, so it is refused.`,
      400,
      "TARGET_SCHOOLS_NOT_ALLOWED"
    );
  }
};

/**
 * The stored-value projection every read returns.
 *
 * `createdBy` is populated to a name and role rather than left as a bare
 * ObjectId: "who published the maintenance notice" is the first question anybody
 * asks, and an id in that slot is a question rather than an answer. It is also the
 * only populated field, so a read costs exactly one `$lookup` rather than
 * resolving an author, a school list and an auditor.
 */
const readProjection = "title body severity targetAudience targetSchoolIds startsAt endsAt isActive createdAt updatedAt";

/**
 * GET /admin/announcements
 *
 * `active=true` means "live right now", not merely "not switched off". The two
 * differ for exactly the two cases the console is built to handle — a notice
 * scheduled for Monday (`isActive: true`, `startsAt` in the future) and one whose
 * window closed yesterday (`isActive: true`, `endsAt` in the past) — and a list
 * that returned either of those under a heading called "live" would be lying to
 * the operator deciding whether the platform currently has a banner up.
 *
 * The query below is `isAnnouncementLive` written as a Mongo filter. The mapping
 * is exact and is the reason this filter is spelled out here rather than built
 * by a helper:
 *
 *   - `isActive: true`                  ← `if (!announcement?.isActive) return false`
 *   - `startsAt: { $lte: now }`         ← `new Date(startsAt) > at` ⇒ not live
 *   - `endsAt: { $in: [null, { $gt: now }] }`  ← `endsAt && endsAt <= at` ⇒ not live
 *
 * The third line is the subtle one. `{ $gt: now }` rather than `{ $gte: now }`
 * reproduces the helper's *exclusive* end. Null is matched explicitly rather
 * than left out of the filter, because "absent" and "not yet set" are different
 * states and a missing `endsAt` in a lean document is easy to mistake for one.
 *
 * Sorted by `startsAt` descending — the newest notice first — which is what
 * `{ isActive: 1, startsAt: -1 }` is indexed for (`PlatformAnnouncement.js:148`).
 * Note the sort is on `startsAt`, not `createdAt`: a maintenance notice written
 * on Friday for Monday must lead a list of what the platform is currently
 * saying, and a notice authored last week but starting today is the more urgent
 * of two rows.
 */
export const listAnnouncements = async ({ active, page, perPage } = {}) => {
  const { skip, limit, page: safePage, perPage: safePerPage } = resolvePagination({
    page,
    perPage,
  });

  const now = new Date();
  const filter = {};

  if (active) {
    filter.isActive = true;
    filter.startsAt = { $lte: now };
    filter.endsAt = { $in: [null, { $gt: now }] };
  }

  const [announcements, total] = await Promise.all([
    PlatformAnnouncement.find(filter)
      .sort({ startsAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit)
      .select(readProjection)
      .populate("createdBy", "name role")
      .lean(),
    PlatformAnnouncement.countDocuments(filter),
  ]);

  return {
    announcements,
    meta: buildMeta({
      page: safePage,
      perPage: safePerPage,
      total,
      // `now` is echoed so a client rendering "live" can show which instant the
      // answer was computed against. Without it, a list fetched at 08:59 and a
      // notice starting at 09:01 disagree on screen and neither can say why.
      extra: { evaluatedAt: now },
    }),
  };
};

/**
 * GET /admin/announcements/:id
 *
 * The single-read path, including an inactive notice. A console that could only
 * read live notices could not answer "what did we publish last Tuesday", and the
 * deactivate-not-delete rule above is worthless without a way to read the row it
 * preserved.
 */
export const getAnnouncement = async (id) => {
  const announcementId = optionalId(id, "announcement ID");
  if (!announcementId) {
    throw new ApiError("An announcement ID is required", 400, "INVALID_ID");
  }

  const announcement = await PlatformAnnouncement.findById(announcementId)
    .select(readProjection)
    .populate("createdBy", "name role")
    .lean();

  if (!announcement) {
    throw new ApiError("Announcement not found", 404, "ANNOUNCEMENT_NOT_FOUND");
  }

  return {
    ...announcement,
    // Reported on every read so the console's detail screen does not re-derive
    // the window test in TypeScript — a fourth implementation, in the client,
    // disagreeing with the three on the server.
    isLive: isAnnouncementLive(announcement, new Date()),
  };
};

/**
 * POST /admin/announcements
 *
 * `createdBy` is a reference to `actor`, exactly as `PlatformSettings.updatedBy`
 * and `SmsJob.updatedBy` are: an announcement is the kind of thing that gets
 * disputed ("who told every school their payments would be down?"), and a copied
 * name is a name that goes stale the moment the person is renamed or leaves.
 *
 * A reference is also the only reason a deactivation can name its author — the
 * console reads `createdBy` on every list row, so the trail does not depend on
 * any single audit entry still being present.
 */
export const createAnnouncement = async (payload = {}, actor, req) => {
  const {
    title,
    body,
    severity,
    targetAudience,
    targetSchoolIds,
    startsAt,
    endsAt,
  } = payload;

  const starts = new Date(startsAt);
  const ends = endsAt ? new Date(endsAt) : null;

  // 422, not 400: the request is syntactically fine and the *shape* is wrong.
  // It is also the same status the Joi layer uses, so a client sees one status
  // for "this announcement is not usable" regardless of which rule caught it.
  if (ends && ends.getTime() <= starts.getTime()) {
    throw new ApiError(
      `endsAt (${ends.toISOString()}) must be after startsAt (${starts.toISOString()}). A window that closes at or before it opens is never live, so the notice could not be shown to anybody even once.`,
      422,
      "INVALID_ANNOUNCEMENT_WINDOW"
    );
  }

  assertAudienceConsistent(targetAudience, toObjectIdList(targetSchoolIds, "school ID"));

  const announcement = await PlatformAnnouncement.create({
    title,
    body,
    severity: severity || "info",
    targetAudience: targetAudience || "all_schools",
    targetSchoolIds: targetAudience === "selected_schools" ? targetSchoolIds : [],
    startsAt: starts,
    endsAt: ends,
    isActive: true,
    createdBy: actor?._id,
  });

  const lean = announcement.toJSON();

  await auditLog(req, {
    action: AUDIT_ACTIONS.ADMIN_ANNOUNCEMENT_CREATE,
    entity: "PlatformAnnouncement",
    entityId: announcement._id,
    userId: actor?._id || req?.user?._id || null,
    // No `schoolId`. This entry is not about one tenant: `all_schools` touches
    // every school, and `selected_schools` touches several. Filing it under any
    // one of them would put a platform-wide notice in that school's private
    // activity log and leave the other schools with no record of it at all.
    meta: {
      before: null,
      after: snapshot(lean),
      title: lean.title,
      severity: lean.severity,
      targetAudience: lean.targetAudience,
      targetSchoolCount: lean.targetSchoolIds?.length || 0,
      startsAt: lean.startsAt,
      endsAt: lean.endsAt ?? null,
      ...impersonationMeta(req),
    },
  });

  return lean;
};

/**
 * PUT /admin/announcements/:id
 *
 * A patch, and the two rules it enforces are checked against the **merged**
 * document rather than against the payload. That distinction is the whole reason
 * this function is not a thin wrapper around the create path:
 *
 *   - Changing `startsAt` on a notice that has an `endsAt` must be checked against
 *     the *stored* `endsAt`. A payload of `{ startsAt: <later than endsAt> }`
 *     with no `endsAt` in it is perfectly well-formed on its own and produces a
 *     window that can never be live.
 *   - Changing `targetAudience` from `selected_schools` to `all_schools` must
 *     clear the stored `targetSchoolIds`, because those ids were being consulted
 *     and after the edit they would not be — the exact "claims a targeting that
 *     does not exist" state `assertAudienceConsistent` exists to prevent.
 *
 * Both are the same class of bug the create path refuses, reached a second way.
 * A patch endpoint that only validated its own payload would let either through.
 */
export const updateAnnouncement = async (id, payload = {}, actor, req) => {
  const announcementId = optionalId(id, "announcement ID");
  if (!announcementId) {
    throw new ApiError("An announcement ID is required", 400, "INVALID_ID");
  }

  const announcement = await PlatformAnnouncement.findById(announcementId);
  if (!announcement) {
    throw new ApiError("Announcement not found", 404, "ANNOUNCEMENT_NOT_FOUND");
  }

  const before = snapshot(announcement.toJSON());

  if (payload.title !== undefined) announcement.title = payload.title;
  if (payload.body !== undefined) announcement.body = payload.body;
  if (payload.severity !== undefined) announcement.severity = payload.severity;
  if (payload.targetAudience !== undefined) {
    announcement.targetAudience = payload.targetAudience;
  }
  if (payload.startsAt !== undefined) announcement.startsAt = new Date(payload.startsAt);
  if (payload.endsAt !== undefined) {
    announcement.endsAt = payload.endsAt ? new Date(payload.endsAt) : null;
  }
  if (payload.isActive !== undefined) announcement.isActive = payload.isActive;
  if (payload.targetSchoolIds !== undefined) {
    announcement.targetSchoolIds = toObjectIdList(
      payload.targetSchoolIds,
      "school ID"
    );
  }

  // Same rule as create, now against the merged document.
  if (announcement.endsAt && announcement.endsAt <= announcement.startsAt) {
    throw new ApiError(
      `endsAt (${announcement.endsAt.toISOString()}) must be after startsAt (${announcement.startsAt.toISOString()}).`,
      422,
      "INVALID_ANNOUNCEMENT_WINDOW"
    );
  }

  assertAudienceConsistent(announcement.targetAudience, announcement.targetSchoolIds);

  await announcement.save();

  const lean = announcement.toJSON();
  const after = snapshot(lean);

  // Which fields actually moved, reported flat. The reference implementation
  // does the same for platform settings (`admin.service.js:516-530`), for the
  // same reason: an entry that records *that* something changed but not what is
  // not an answer to the question an audit log exists for.
  const changedFields = ANNOUNCEMENT_AUDIT_FIELDS.filter((field) =>
    String(before[field] ?? "") !== String(after[field] ?? "")
  );

  // A no-op PUT is not an error. It writes no audit entry, exactly as
  // `updatePlatformSettingsController` skips its write when `changed` is empty
  // (`controllers/admin.controller.js:230`): a console that re-submits an
  // unchanged form on every save would otherwise bury the entries that matter.
  if (changedFields.length) {
    await auditLog(req, {
      action: AUDIT_ACTIONS.ADMIN_ANNOUNCEMENT_UPDATE,
      entity: "PlatformAnnouncement",
      entityId: announcement._id,
      userId: actor?._id || req?.user?._id || null,
      meta: {
        before,
        after,
        changedFields,
        ...impersonationMeta(req),
      },
    });
  }

  return { announcement: lean, changedFields };
};

/**
 * DELETE /admin/announcements/:id — withdraw, do not erase.
 *
 * Sets `isActive: false` and returns the notice. The full argument for not
 * hard-deleting is at the top of this file; the short form is that the platform
 * cannot un-tell a school something it already showed them, and this row is the
 * evidence that it was told.
 *
 * `admin.announcement_delete` is the matching action even though nothing is
 * deleted. The enum is the contract (`models/AuditLog.js:99-101`) and inventing a
 * softer name for it would mean adding a value that has to stay in step with that
 * array — a `ValidationError` `auditService` swallows into a `console.error`
 * (`utils/auditService.js:46`), leaving an entry that silently does not exist.
 *
 * Already-inactive is a 409 rather than a silent success: withdrawing a notice
 * twice is a script that ran twice, and answering "yes, it is withdrawn" the
 * second time would hide that. The state is correct; the *request* is not.
 */
export const deactivateAnnouncement = async (id, actor, req) => {
  const announcementId = optionalId(id, "announcement ID");
  if (!announcementId) {
    throw new ApiError("An announcement ID is required", 400, "INVALID_ID");
  }

  const announcement = await PlatformAnnouncement.findById(announcementId);
  if (!announcement) {
    throw new ApiError("Announcement not found", 404, "ANNOUNCEMENT_NOT_FOUND");
  }

  if (!announcement.isActive) {
    throw new ApiError(
      "This announcement is already withdrawn. It is kept on record — the schools it was shown to were told, and that record is the point — but there is nothing further to withdraw.",
      409,
      "ANNOUNCEMENT_ALREADY_INACTIVE"
    );
  }

  const before = snapshot(announcement.toJSON());
  const wasLive = isAnnouncementLive(announcement, new Date());

  announcement.isActive = false;
  await announcement.save();

  const lean = announcement.toJSON();

  await auditLog(req, {
    action: AUDIT_ACTIONS.ADMIN_ANNOUNCEMENT_DELETE,
    entity: "PlatformAnnouncement",
    entityId: announcement._id,
    userId: actor?._id || req?.user?._id || null,
    meta: {
      before,
      after: snapshot(lean),
      // Recorded because it is the difference between "we withdrew a live
      // banner" and "we withdrew something that was scheduled or already
      // expired" — and those two get very different follow-up. During an outage,
      // an operator taking down the banner that 300 schools are currently reading
      // needs that fact in the trail.
      wasLiveAtWithdrawal: wasLive,
      withdrawnBy: String(actor?._id || req?.user?._id || ""),
      ...impersonationMeta(req),
    },
  });

  return { announcement: lean, wasLiveAtWithdrawal: wasLive };
};

/**
 * The ObjectId check, re-exported from mongoose rather than duplicated.
 *
 * Present so a reader looking for "how does this file validate an id" finds the
 * answer in the file they are reading. The actual work is in `optionalId`,
 * which throws `ApiError(…, 400, "INVALID_ID")` for a malformed id — a malformed
 * id is a bad request, not a missing record, and reporting it as a 404 tells the
 * operator the announcement does not exist when the URL is simply wrong.
 */
export const isValidAnnouncementId = (value) =>
  Boolean(value) && mongoose.Types.ObjectId.isValid(value);