import mongoose from "mongoose";

/**
 * One teacher's responsibility for one student, as a first-class record.
 *
 * ## Why a collection, when `User.assignedClasses` already links teachers to
 * classes
 *
 * Because the question this answers is not the question a class answers.
 * `assignedClasses` says *who teaches JHS 2 Mathematics*; this says *which
 * individual children this teacher is looking after*. A form teacher, a remedial
 * teacher and a house master can all hold the same child, a child can be looked
 * after by two of them at once, and the headmaster's commonest question is
 * "who has Kwesi?" — which against an array of classes on a user is a collection
 * scan, and against this is one index read.
 *
 * Denormalising the other way (an `assignedTeacherIds` array on `Student`) was
 * the other candidate and loses on both counts: the array grows without bound
 * across years, and the page's main query is *by teacher*, which is exactly the
 * query an array on the student cannot answer.
 *
 * ## `classMediated`
 *
 * True when the link was created by assigning a whole class (`Workflow C` in the
 * UI), false when an admin picked the student individually. The distinction is
 * load-bearing rather than descriptive: removing a teacher's *individual* picks
 * must not silently orphan children a class assignment put there, so the
 * unassign endpoint refuses to drop a `classMediated` row unless the caller
 * passes `force`. Without this flag the UI would have to guess, and a guess that
 * is wrong the first time it matters is a bug filed against the teacher, not the
 * flag.
 *
 * ## Soft removal
 *
 * `removedAt` rather than a hard delete, and the unique partial index below is
 * what makes that work: the row is excluded from the index once `removedAt` is
 * set, so re-assigning the same pair creates a new row instead of colliding with
 * the tombstone. The history — who unassigned whom, and when — is the answer to
 * "why did my roster change" six months later, and it costs nothing to keep.
 */

const teacherAssignmentSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },

    /** The teacher being held responsible. A `teacher` or `school_admin` account. */
    teacherId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },

    /** The child being looked after. */
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
    },

    /**
     * Class name, populated on both paths.
     *
     * On the individual path it is read off the student at write time, which is
     * deliberately a *copy*: the roster's own `studentClass` is the truth and
     * this is what the student was in when the link was made. A student promoted
     * mid-year then leaves the assignment's own record coherent — the teacher
     * was responsible for them in that class, whatever they moved on to.
     */
    className: { type: String, trim: true, maxlength: 50, default: "" },

     /** True when a class assignment produced this row rather than an individual pick. */
     classMediated: { type: Boolean, default: false },

     /** 'CT' (class teacher) or 'ST' (subject teacher) for this link. */
     tag: { type: String, trim: true, maxlength: 2, default: "" },


    /** The admin who made the link. */
    assignedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    /** Set when the link was withdrawn; null while it is live. */
    removedAt: { type: Date, default: null },
  },
  // `timestamps: false` on purpose: `assignedAt` is the only date the record
  // needs, and a `createdAt` speaking the same truth under a second name is a
  // field somebody later reads by mistake. `removedAt` is written, never
  // updated — an audit row is not a mutating row.
  { timestamps: false }
);

/**
 * The two queries this model exists for.
 *
 *   - `{ schoolId, teacherId }` — "show me this teacher's students", the page's
 *     main list and the source of its counts.
 *   - `{ schoolId, studentId }` — "who is looking after this child", asked from
 *     the student's own record.
 *
 * The compound unique index is what keeps one teacher from being linked twice
 * to the same student, and its `partialFilterExpression` is what makes a
 * re-assignment after an un-assignment legal: only live rows are in the index,
 * so a tombstone never blocks the same pair from being linked again. It is also
 * the idempotency guarantee — a duplicate assign is a no-op rather than an
 * error, which matters because two admins on one school are a real state.
 */
teacherAssignmentSchema.index({ schoolId: 1, teacherId: 1 });
teacherAssignmentSchema.index({ schoolId: 1, studentId: 1 });
teacherAssignmentSchema.index(
  { schoolId: 1, teacherId: 1, studentId: 1 },
  {
    unique: true,
    partialFilterExpression: { removedAt: null },
    name: "teacher_assignment_live_unique",
  }
);

/**
 * Custom query helpers.
 *
 * `live` is used by every read in the service, and putting it here rather than
 * repeating `{ removedAt: null }` at each call site means a filtered-out row can
 * never leak into a list because one of six call sites forgot it. `softDelete`
 * is the single write path for withdrawing a link, so the `removedAt` stamp is
 * set in exactly one place.
 */
teacherAssignmentSchema.query.live = function live() {
  return this.where({ removedAt: null });
};

teacherAssignmentSchema.methods.softDelete = function softDelete() {
  this.removedAt = new Date();
  return this.save();
};

export const TEACHER_ASSIGNMENT_MODEL = "TeacherAssignment";

export const TeacherAssignment = mongoose.model(
  TEACHER_ASSIGNMENT_MODEL,
  teacherAssignmentSchema
);

export default TeacherAssignment;
