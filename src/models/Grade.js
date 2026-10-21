import mongoose from "mongoose";

/**
 * One student's score for one subject, one assessment, one term.
 *
 * This is the **grade book** — the running record a subject teacher keeps as
 * the term goes along. It is deliberately separate from `ReportCard`: a report
 * card is the terminal, compiled, *published* artefact a parent sees, while a
 * grade row is the working mark a teacher enters on a Tuesday and corrects on a
 * Thursday. Compiling a report card today reads its scores from the request
 * payload (`admin/records.service.js`), so nothing here changes what a parent
 * can see — this collection exists so the teacher portal has somewhere to put a
 * mark *before* anything is compiled, and so a score survives the term.
 *
 * Uniqueness is `{ schoolId, studentId, subject, term, academicYear,
 * assessmentType }` — one row per student per subject per assessment. That is
 * the whole reason the saves are upserts: a teacher correcting 62 to 68 must
 * land on the same row, and a second submission must not produce a second mark
 * for the same test.
 *
 * ## Several assessments, not one
 *
 * `assessmentType` is the Ghanaian terminal report's split: a **class
 * assessment** worth 30% of the total, broken into the parts the school runs
 * (a class test, group work, homework, class work), and an **exam score**
 * worth 70%. A subject is therefore a *set* of rows here, and the report
 * card's "Class Score (30)" and "Total (100)" are computed from that set at
 * compile time (see `utils/subjectResults.js`) rather than stored — a total
 * is a fact about several marks and any of them can be corrected afterwards.
 *
 * `maxScore` is recorded per row rather than assumed, because a school that
 * marks its class test out of 50, or its homework out of 20, must be able to
 * say so: the normalisation at compile time divides by what was actually
 * recorded.
 *
 * Not partial on `deletedAt`, and deliberately so: a soft-deleted row is
 * *reused* by the next write rather than colliding into a duplicate-key error,
 * which is the same contract `Attendance` already runs on (see the comment on
 * `attendanceSchema.index`). A teacher must never see a 500 for re-entering a
 * mark they previously deleted.
 */
const gradeSchema = new mongoose.Schema(
  {
    schoolId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "School",
      required: true,
      index: true,
    },
    studentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Student",
      required: true,
      index: true,
    },
    // Denormalised from the student rather than joined: every read of this
    // collection is by class (the class grade book), and a student who was
    // promoted mid-term keeps the class the mark was recorded against.
    className: { type: String, required: true, trim: true, index: true },
    subject: { type: String, required: true, trim: true },
    term: {
      type: String,
      enum: ["Term 1", "Term 2", "Term 3"],
      required: true,
      index: true,
    },
    academicYear: { type: String, required: true, index: true },
    // The assessment this row holds.
    //
    // A Ghanaian terminal report is a **30/70 split**: a class assessment
    // worth 30% of the total and an end-of-term examination worth 70%. The
    // class assessment is itself gathered across the term from several parts
    // — a class test, group work, homework, class work — and the school
    // decides how the 30 points are shared between them
    // (`utils/gradingConfig.js`).
    //
    // So a subject is a *set* of rows, not a pair:
    //
    //   class_test | group_work | homework | class_work   the parts
    //   exam_score                                            the exam
    //   class_score                          a direct class score, for a
    //                                          school that does not break
    //                                          the class assessment down
    //
    // The report card's "Class Score (30)" and "Total (100)" are computed from
    // those rows at compile time (see `utils/subjectResults.js`) rather than
    // stored — a total is a fact about several marks and any of them can be
    // corrected after the fact.
    assessmentType: {
      type: String,
      enum: [
        "class_score",
        "class_test",
        "group_work",
        "homework",
        "class_work",
        "exam_score",
      ],
      required: true,
    },
    score: { type: Number, required: true, min: 0 },
    // The mark this row was recorded against — 100 for a class test marked out
    // of 100, 20 for two pieces of homework marked out of 20, 100 for an
    // exam. Recorded rather than assumed so the compile-time normalisation
    // divides by what the school actually used.
    maxScore: { type: Number, required: true, min: 1, default: 100 },
    // Stored, not derived on read: the band a mark earned at the time it was
    // recorded is a fact about that mark, and `gradeBands.js` bands have moved
    // before. A percentage is re-derivable; a grade is not.
    //
    // This is the band of *this row's own mark*. The grade printed on a report
    // card is the band of the **total** (class + exam), and it is computed at
    // compile time — a class score of 45/50 is an A on its own and is not the
    // student's grade in that subject.
    grade: { type: String, default: "", trim: true },

    // ── Approval workflow ──
    //
    // A mark a teacher types is a *claim* the school has not yet signed off, and
    // a parent must never read an unsigned mark through a pay link. Every row
    // therefore lands in `draft`; the teacher submits the class, which moves the
    // block to `submitted`; the headmaster approves or rejects per class.
    //
    // Rejection is the only path back to editable: it returns the block to
    // `draft` so the teacher can correct and resubmit. `rejectionReason` rides
    // on every row so the reason travels with the mark rather than living in a
    // chat the next teacher will not find.
    approvalStatus: {
      type: String,
      enum: ["draft", "submitted", "approved", "rejected"],
      default: "draft",
      index: true,
    },
    submittedAt: { type: Date, default: null },
    submittedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    approvedAt: { type: Date, default: null },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectedAt: { type: Date, default: null },
    rejectedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    rejectionReason: { type: String, default: "", maxlength: 500 },

    recordedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    recordedAt: { type: Date, default: Date.now },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

// The upsert key. Every write in `grades.service.js` filters on exactly these
// six fields and nothing else.
gradeSchema.index(
  {
    schoolId: 1,
    studentId: 1,
    subject: 1,
    term: 1,
    academicYear: 1,
    assessmentType: 1,
  },
  { unique: true }
);
// The class grade book's read: one class, one subject, one term.
gradeSchema.index({ schoolId: 1, className: 1, subject: 1, term: 1 });
// The headmaster's review queue and the report-card compiler's filter: every
// `submitted` (or `approved`) block in a school, narrowed by term and year.
gradeSchema.index({ schoolId: 1, approvalStatus: 1, term: 1 });

export const Grade = mongoose.model("Grade", gradeSchema);
