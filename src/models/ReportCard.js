import mongoose from "mongoose";

/**
 * One student's terminal report for one term.
 *
 * A report card is *compiled* from subject scores supplied by the class teacher
 * and only becomes visible to a parent when a headteacher publishes it — so
 * `status` is the boundary between work in progress and a published record, and
 * every parent read filters on `status: "published"`. A draft left behind by a
 * half-finished compile must never be readable through a public pay link.
 *
 * Uniqueness is `{ schoolId, studentId, term, academicYear }`: one card per
 * student per term, re-compiled in place rather than stacked. `className` is
 * denormalised alongside it because the class-wide reads (rank, preview,
 * publish) are all by class, and a student who has been promoted mid-year keeps
 * the class the card was compiled against.
 *
 * ## The subject row is a breakdown, not a number
 *
 * A Ghanaian terminal report prints, for every subject: the Class Score, the
 * Exam Score, the Total, the Grade, and the position the student came in that
 * subject. So the subject row carries all five, and `totalScore` is the
 * server's answer rather than the teacher's — it is computed from the class
 * assessment and the examination at compile time (see
 * `utils/subjectResults.js`).
 *
 * The two figures are weighted: the class score is out of 30 and the exam's
 * points are out of 70, so they add up to the total out of 100. A card
 * compiled before the 30/70 weighting still renders — the figures are read
 * with their own maxima.
 *
 * `score` and `maxScore` are kept as the single-figure mirror of `totalScore`
 * so a card compiled before the split still renders, and so the parent
 * portal's older reads keep working.
 */
const subjectGradeSchema = new mongoose.Schema(
  {
    subject: { type: String, required: true, trim: true },

    // ── The Ghanaian breakdown ──
    //
    // The two figures are the ones that add up to the total: the class score
    // out of 30 (the 30% the class assessment carries) and the exam's points
    // out of 70 (the 70% the examination carries). The exam's *raw* mark, out
    // of 100, is what the teacher typed; this is the figure the report prints
    // beside the class score, and it is what makes Class + Exam = Total.
    classScore: { type: Number, default: null, min: 0 },
    classMaxScore: { type: Number, default: 30, min: 1 },
    examScore: { type: Number, default: null, min: 0 },
    examMaxScore: { type: Number, default: 70, min: 1 },
    totalScore: { type: Number, default: null, min: 0, max: 100 },
    // Not required: a subject with only one of its two halves recorded has no
    // grade yet, and an empty string is the honest answer. Mongoose's
    // `required` rejects `""`, which would make an incomplete subject
    // unsaveable — and an unsaveable report card is how a class with no exam
    // marks yet ends up with no report card at all.
    grade: { type: String, default: "", trim: true },
    meaning: { type: String, default: "", trim: true },
    // "1st", "2nd", "3rd" — the student's rank in this subject across the class.
    subjectPosition: { type: String, default: "", trim: true },

    // The single-figure mirror of `totalScore`, for readers that predate the
    // split and for cards compiled before it.
    score: { type: Number, default: null, min: 0 },
    maxScore: { type: Number, default: 100, min: 1 },

    remark: { type: String, default: "", maxlength: 200 },
    teacher: { type: String, default: "" },
  },
  { _id: false }
);

const reportCardSchema = new mongoose.Schema(
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
    className: { type: String, required: true, trim: true, index: true },
    term: {
      type: String,
      enum: ["Term 1", "Term 2", "Term 3"],
      required: true,
      index: true,
    },
    academicYear: { type: String, required: true, index: true },

    subjects: { type: [subjectGradeSchema], default: [] },
    average: { type: Number, default: 0, min: 0, max: 100 },
    position: { type: Number, default: null },
    classSize: { type: Number, default: null },
    grade: { type: String, default: "", trim: true },

    teacherRemark: {
      text: { type: String, default: "", maxlength: 500 },
      author: { type: String, default: "" },
    },
    headRemark: {
      text: { type: String, default: "", maxlength: 500 },
      author: { type: String, default: "" },
    },

    conduct: { type: String, default: "" },
    attendance: {
      present: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
    },

    pdfUrl: { type: String, default: null },
    pdfPublicId: { type: String, default: null },

    // draft → review → published (archived is a terminal park).
    //
    // `review` is the state between the headmaster compiling a class and
    // deciding to publish it: the numbers are assembled and a remark is being
    // written, but the parents still cannot see it. It exists so the review
    // queue has something to list — a card that is neither a freshly seeded
    // `draft` nor a live `published` one. The parent read still filters on
    // `status: "published"`, so this is invisible outside the admin console.
    //
    // `archived` is where a superseded or withdrawn card goes; it reads exactly
    // like an unpublished one to a parent.
    status: {
      type: String,
      enum: ["draft", "review", "published", "archived"],
      default: "draft",
      index: true,
    },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    publishedAt: { type: Date, default: null },
    publishedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    deletedAt: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

reportCardSchema.index(
  { schoolId: 1, studentId: 1, term: 1, academicYear: 1 },
  { unique: true }
);
// The compile and publish reads: every card in one class for one term.
reportCardSchema.index({ schoolId: 1, className: 1, term: 1, academicYear: 1 });

export const ReportCard = mongoose.model("ReportCard", reportCardSchema);
