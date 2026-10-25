import mongoose from "mongoose";
import { Grade } from "../../models/Grade.js";
import { User } from "../../models/userModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";

/**
 * The grade approval workflow — the review layer between a teacher who enters
 * marks and the report cards a parent eventually reads.
 *
 * A mark is a *claim* until the school signs it off. The four transitions here
 * are the whole of that signing:
 *
 *     draft ──submit──▶ submitted ──approve──▶ approved
 *                    ◀──reopen── rejected ◀──reject──
 *
 * Every transition is a `bulk` state change over a *block* — one class, one
 * subject, one term — because that is the unit a teacher enters and a headmaster
 * reviews. Approval is a stamp, not an edit: the numbers are already fixed and
 * this only moves the state and records who moved it.
 *
 * Every write is scoped to `schoolId`, which the route resolves from the
 * caller's own token. A school's headmaster can never reach another school's
 * marks, because the filter carries their school and nothing the client sends
 * can widen it.
 */

/** The four states, in the order they occur. Used only as documentation. */
export const GRADE_STATUSES = ["draft", "submitted", "approved", "rejected"];

const asObjectId = (value) => new mongoose.Types.ObjectId(String(value));

const assertTermScope = ({ term, academicYear }) => {
  if (!term || !academicYear) {
    throw new ApiError(
      "term and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }
};

/**
 * Submit every draft grade for a class, subject and term.
 *
 * The class teacher does this after entering the whole column. The drafts move
 * to `submitted` in one query; nothing is re-read or re-checked, because the
 * teacher may submit many times before the headmaster looks. Once submitted the
 * teacher cannot edit the marks — only an admin can move them from here — so
 * this is the honest hand-off.
 */
export const submitClassGrades = async (schoolId, userId, payload) => {
  const { className, subject, term, academicYear } = payload;
  if (!className || !term || !academicYear) {
    throw new ApiError(
      "className, term, and academicYear are required",
      400,
      "VALIDATION_ERROR"
    );
  }

  const filter = {
    schoolId,
    className,
    term,
    academicYear,
    approvalStatus: "draft",
    deletedAt: null,
  };
  // An omitted subject submits the whole class — every subject typed for that
  // class and term at once. A teacher who marks four subjects in JHS 2A presses
  // "submit class" once, not four times.
  if (subject) filter.subject = subject;

  const result = await Grade.updateMany(filter, {
    $set: {
      approvalStatus: "submitted",
      submittedAt: new Date(),
      submittedBy: userId,
    },
  });

  await auditLog({
    action: AUDIT_ACTIONS.GRADE_SUBMIT,
    entity: "Grade",
    userId,
    schoolId,
    meta: {
      className,
      subject: subject || null,
      term,
      academicYear,
      submitted: result.modifiedCount,
    },
  });

  return {
    className,
    subject: subject || null,
    term,
    academicYear,
    submitted: result.modifiedCount,
  };
};

/**
 * Approve submitted grades.
 *
 * The headmaster sees the block and approves it. This is a stamp — the numbers
 * do not change, only the state and the approver's name do. Narrows to
 * `approvalStatus: "submitted"` so a second approval of an already-approved
 * block is a no-op rather than a re-stamp, and an optional `ids` list approves
 * a hand-picked subset (one subject teacher's portion of a mixed block).
 */
export const approveClassGrades = async (schoolId, userId, payload) => {
  const { className, subject, term, academicYear, ids } = payload;
  assertTermScope({ term, academicYear });

  const filter = {
    schoolId,
    term,
    academicYear,
    approvalStatus: "submitted",
    deletedAt: null,
  };
  if (className) filter.className = className;
  if (subject) filter.subject = subject;
  if (Array.isArray(ids) && ids.length) {
    filter._id = { $in: ids.map(asObjectId) };
  }

  const result = await Grade.updateMany(filter, {
    $set: {
      approvalStatus: "approved",
      approvedAt: new Date(),
      approvedBy: userId,
    },
  });

  await auditLog({
    action: AUDIT_ACTIONS.GRADE_APPROVE,
    entity: "Grade",
    userId,
    schoolId,
    meta: {
      className: className || null,
      subject: subject || null,
      term,
      academicYear,
      approved: result.modifiedCount,
    },
  });

  // Auto-compile and publish report cards from the newly approved grades so
  // parents receive them without a separate publish step.
  if (className && term && academicYear) {
    try {
      const { compileClassReportsFromGrades, publishClassReports } = await import("./recordsApproval.service.js");
      await compileClassReportsFromGrades(schoolId, userId, { className, term, academicYear });
      await publishClassReports(schoolId, userId, { className, term, academicYear });
    } catch {
      // Best-effort: approval still succeeds even if compile/publish fails.
    }
  }

  return { approved: result.modifiedCount };
};

/**
 * Reject submitted grades.
 *
 * Sends the block back so the teacher can correct it, and records the reason on
 * every row — the reason travels with the mark rather than living in a message
 * the next teacher will not find. `rejected` is deliberately *not* editable
 * directly: the teacher calls `reopenRejectedGrades` to move the block back to
 * `draft`, which clears the reason and unsets the rejection stamp. A rejection
 * with no real reason is refused: "rejected" with a blank field tells the
 * teacher nothing.
 */
export const rejectClassGrades = async (schoolId, userId, payload) => {
  const { className, subject, term, academicYear, reason } = payload;
  assertTermScope({ term, academicYear });
  if (!reason || reason.trim().length < 5) {
    throw new ApiError(
      "A rejection reason of at least 5 characters is required",
      400,
      "REASON_REQUIRED"
    );
  }

  const filter = {
    schoolId,
    term,
    academicYear,
    approvalStatus: "submitted",
    deletedAt: null,
  };
  if (className) filter.className = className;
  if (subject) filter.subject = subject;

  const result = await Grade.updateMany(filter, {
    $set: {
      approvalStatus: "rejected",
      rejectedAt: new Date(),
      rejectedBy: userId,
      rejectionReason: reason.trim(),
    },
  });

  await auditLog({
    action: AUDIT_ACTIONS.GRADE_REJECT,
    entity: "Grade",
    userId,
    schoolId,
    meta: {
      className: className || null,
      subject: subject || null,
      term,
      academicYear,
      rejected: result.modifiedCount,
      reason: reason.trim(),
    },
  });

  return { rejected: result.modifiedCount };
};

/**
 * Reopen a rejected block back to `draft`.
 *
 * The teacher presses "Edit" on a rejected class and the marks become editable
 * again. The reason and the rejection stamp are cleared so the next submission
 * is clean. Only `rejected` rows move — an in-flight `submitted` block is left
 * alone, because reopening it would pull a class out of the headmaster's queue
 * that they have not acted on yet.
 */
export const reopenRejectedGrades = async (schoolId, userId, payload) => {
  const { className, subject, term, academicYear } = payload;
  assertTermScope({ term, academicYear });

  const filter = {
    schoolId,
    term,
    academicYear,
    approvalStatus: "rejected",
    deletedAt: null,
  };
  if (className) filter.className = className;
  if (subject) filter.subject = subject;

  const result = await Grade.updateMany(filter, {
    $set: {
      approvalStatus: "draft",
      rejectionReason: "",
    },
    $unset: {
      rejectedAt: 1,
      rejectedBy: 1,
    },
  });

  await auditLog({
    action: AUDIT_ACTIONS.GRADE_REOPEN,
    entity: "Grade",
    userId,
    schoolId,
    meta: {
      className: className || null,
      subject: subject || null,
      term,
      academicYear,
      reopened: result.modifiedCount,
    },
  });

  return { reopened: result.modifiedCount };
};

/**
 * The headmaster's review queue: every submitted block awaiting approval.
 *
 * Grouped by `className + subject + term + academicYear` — the unit that was
 * submitted — with the count, who submitted it, and the earliest submit time,
 * so the queue can be worked oldest-first. Submitter names are resolved in one
 * query after the grouping rather than with a per-group join.
 *
 * **Two counts, because a subject is several rows.** Every subject now carries
 * the parts of its class assessment *and* its exam score, so a class of thirty
 * contributes a hundred and fifty rows. A `count` is the number of grade rows —
 * the size of the block as stored — and a `studentCount` is how many children
 * it covers, which is the number the headmaster actually recognises ("thirty
 * children, Mathematics").
 */
export const getGradeApprovalQueue = async (schoolId, { term, academicYear } = {}) => {
  const match = {
    schoolId: asObjectId(schoolId),
    approvalStatus: "submitted",
    deletedAt: null,
  };
  if (term) match.term = term;
  if (academicYear) match.academicYear = academicYear;

  const grouped = await Grade.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          className: "$className",
          subject: "$subject",
          term: "$term",
          academicYear: "$academicYear",
        },
        count: { $sum: 1 },
        students: { $addToSet: "$studentId" },
        submittedBy: { $first: "$submittedBy" },
        submittedAt: { $min: "$submittedAt" },
      },
    },
    {
      $project: {
        _id: 0,
        className: "$_id.className",
        subject: "$_id.subject",
        term: "$_id.term",
        academicYear: "$_id.academicYear",
        count: 1,
        studentCount: { $size: "$students" },
        submittedBy: 1,
        submittedAt: 1,
      },
    },
    { $sort: { submittedAt: 1 } },
  ]);

  const userIds = [
    ...new Set(
      grouped.map((g) => g.submittedBy?.toString()).filter(Boolean)
    ),
  ];
  const users = await User.find({ _id: { $in: userIds } })
    .select("_id name")
    .lean();
  const nameById = new Map(users.map((u) => [String(u._id), u.name]));

  return {
    queue: grouped.map((g) => ({
      className: g.className,
      subject: g.subject,
      term: g.term,
      academicYear: g.academicYear,
      count: g.count,
      studentCount: g.studentCount ?? g.count,
      submittedBy: g.submittedBy,
      submittedByName: g.submittedBy
        ? nameById.get(String(g.submittedBy)) || ""
        : "",
      submittedAt: g.submittedAt,
    })),
  };
};
