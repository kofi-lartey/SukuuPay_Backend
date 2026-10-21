/**
 * Folds the old assessment vocabulary into the terminal report's two columns.
 *
 * Run: MONGODB_URI=... node scripts/migrate-grades-to-class-exam.mjs [--apply]
 *
 * ## Why
 *
 * `Grade.assessmentType` used to be `class_test | quiz | assignment | exam`:
 * a school running many small tests and averaging them. A Ghanaian terminal
 * report has no such columns — it has a **Class Score (out of 50)** and an
 * **Exam Score (out of 100)** — so the grade book now stores exactly those two
 * and nothing else.
 *
 * Mongoose does not rewrite stored documents when an enum changes, so every
 * row still holding a retired value is invisible to the new compiler: it
 * filters on `class_score` / `exam_score` and finds nothing, and a class whose
 * marks exist only in the old vocabulary compiles to a report card with no
 * subjects at all. That is a silent empty result, which is the worst kind.
 *
 * ## The mapping
 *
 *   class_test  → class_score
 *   quiz        → class_score
 *   assignment  → class_score
 *   exam        → exam_score
 *
 * The three continuous-assessment types collapse onto one class score, because
 * they are now one column. A student who sat three quizzes and a class test has
 * four rows, and the unique index allows only one class score per student per
 * subject — so the four are **averaged into one mark**, scaled onto 50.
 *
 * Averaging percentages rather than raw marks is the point: a quiz out of 10
 * and a class test out of 50 carry the same weight in a Ghanaian school, and
 * adding them would produce a number that means nothing.
 *
 * ## What is *not* touched
 *
 * A row that is already in the new vocabulary wins outright: if a teacher has
 * already entered the class score and the exam score under the new scheme,
 * the legacy rows are discarded rather than averaged over the new ones. The
 * new marks are the ones the school is working from.
 *
 * The approval state is carried across, and `approved` wins: a mark the
 * headmaster has already signed must not drop back to `draft` and vanish from
 * the compiler, which reads only approved rows.
 *
 * ## Safety
 *
 * Idempotent: the filter matches only documents whose assessment type is one
 * of the four retired values, so re-running is a no-op. Dry-run by default;
 * `--apply` writes. Every affected block is printed so the output is the
 * audit trail.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';
import { Grade } from '../src/models/Grade.js';
import { gradeForScore, CLASS_SCORE_MAX, EXAM_SCORE_MAX } from '../src/utils/gradeBands.js';

const APPLY = process.argv.includes('--apply');

/** The retired vocabulary and what each value becomes. */
const REMAP = {
  class_test: 'class_score',
  quiz: 'class_score',
  assignment: 'class_score',
  exam: 'exam_score',
};

const LEGACY_TYPES = Object.keys(REMAP);

/**
 * The block a row belongs to: the same key the unique index uses.
 *
 * Two rows are in the same block when everything but the assessment type
 * matches — and that is exactly the group that has to be collapsed.
 */
const blockKey = (grade) =>
  [
    String(grade.schoolId),
    String(grade.studentId),
    grade.className,
    grade.subject,
    grade.term,
    grade.academicYear,
  ].join('|');

/**
 * The approval state a collapsed block carries.
 *
 * `approved` wins, because the compiler reads only approved rows and a
 * headmaster's signature must not be undone by a migration. Then `submitted`
 * (the teacher handed it in), then `rejected` (the block came back to be
 * corrected), then `draft`.
 */
const STATUS_PRECEDENCE = ["approved", "submitted", "rejected", "draft"];
const strongestStatus = (statuses) =>
  STATUS_PRECEDENCE.find((status) => statuses.includes(status)) || "draft";

/**
 * The class score a group of continuous-assessment marks collapses into.
 *
 * The percentages are averaged and the result is scaled onto 50 — the mark the
 * terminal report's class-score column is out of. A group with no usable mark
 * at all yields `null`, and the caller leaves the block alone.
 */
const collapseToClassScore = (rows) => {
  const percentages = rows
    .map((row) => {
      const max = Number(row.maxScore) || 100;
      if (!max) return null;
      const pct = (Number(row.score) / max) * 100;
      return Number.isFinite(pct) ? pct : null;
    })
    .filter((pct) => pct !== null);

  if (!percentages.length) return null;

  const average = percentages.reduce((sum, pct) => sum + pct, 0) / percentages.length;
  return {
    score: Math.round((average / 100) * CLASS_SCORE_MAX),
    maxScore: CLASS_SCORE_MAX,
  };
};

if (!MONGODB_URI) {
  console.error("MONGODB_URI is not set. Nothing to do.");
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log(
    `Connected to ${mongoose.connection.name}. ${
      APPLY ? "Applying." : "Dry run — pass --apply to write."
    }\n`
  );

  const legacy = await Grade.find({
    assessmentType: { $in: LEGACY_TYPES },
    deletedAt: null,
  })
    .select(
      "schoolId studentId className subject term academicYear assessmentType score maxScore grade approvalStatus recordedBy recordedAt submittedAt submittedBy approvedAt approvedBy rejectedAt rejectedBy rejectionReason"
    )
    .lean();

  if (legacy.length === 0) {
    console.log("No grades hold a retired assessment type. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  // Group the legacy rows into the blocks that have to be collapsed.
  const blocks = new Map();
  for (const row of legacy) {
    const key = `${blockKey(row)}|${REMAP[row.assessmentType]}`;
    const list = blocks.get(key) || [];
    list.push(row);
    blocks.set(key, list);
  }

  // The rows already in the new vocabulary, so a teacher who has already
  // entered the new breakdown is not overwritten by the legacy average.
  const existing = await Grade.find({
    assessmentType: { $in: ["class_score", "exam_score"] },
    deletedAt: null,
  })
    .select("schoolId studentId className subject term academicYear assessmentType")
    .lean();

  const existingByBlock = new Set(
    existing.map((row) => `${blockKey(row)}|${row.assessmentType}`)
  );

  const writes = [];
  const deletes = [];
  let replaced = 0;
  let created = 0;

  for (const [key, rows] of blocks) {
    const target = REMAP[rows[0].assessmentType];
    const representative = rows[0];

    if (existingByBlock.has(key)) {
      // The school is already on the new scheme for this block — drop the
      // legacy rows and leave the new ones alone.
      deletes.push(...rows.map((row) => row._id));
      replaced += rows.length;
      console.log(
        `  ${representative.className} · ${representative.subject} · ${representative.term} · ${target}  — already recorded, ${rows.length} legacy row(s) discarded`
      );
      continue;
    }

    const mark =
      target === "class_score"
        ? collapseToClassScore(rows)
        : {
            // The exam was already one mark out of its own maximum; keep it.
            score: Number(representative.score),
            maxScore: Number(representative.maxScore) || EXAM_SCORE_MAX,
          };

    if (!mark || !Number.isFinite(mark.score)) {
      console.log(
        `  ${representative.className} · ${representative.subject} · ${representative.term} · ${target}  — skipped, no usable mark`
      );
      continue;
    }

    const status = strongestStatus(rows.map((row) => row.approvalStatus));

    writes.push({
      updateOne: {
        filter: {
          schoolId: representative.schoolId,
          studentId: representative.studentId,
          className: representative.className,
          subject: representative.subject,
          term: representative.term,
          academicYear: representative.academicYear,
          assessmentType: target,
        },
        update: {
          $set: {
            schoolId: representative.schoolId,
            studentId: representative.studentId,
            className: representative.className,
            subject: representative.subject,
            term: representative.term,
            academicYear: representative.academicYear,
            assessmentType: target,
            score: mark.score,
            maxScore: mark.maxScore,
            grade: gradeForScore(mark.score, mark.maxScore),
            approvalStatus: status,
            recordedBy: representative.recordedBy,
            recordedAt: representative.recordedAt,
            ...(status === "submitted" || status === "approved"
              ? {
                  submittedAt: representative.submittedAt,
                  submittedBy: representative.submittedBy,
                }
              : {}),
            ...(status === "approved"
              ? { approvedAt: representative.approvedAt, approvedBy: representative.approvedBy }
              : {}),
            ...(status === "rejected"
              ? {
                  rejectedAt: representative.rejectedAt,
                  rejectedBy: representative.rejectedBy,
                  rejectionReason: representative.rejectionReason || "",
                }
              : {}),
          },
        },
        upsert: true,
      },
    });

    deletes.push(...rows.map((row) => row._id));
    created += 1;

    console.log(
      `  ${representative.className} · ${representative.subject} · ${representative.term} · ${target}  — ${rows.length} row(s) → ${mark.score}/${mark.maxScore} (${status})`
    );
  }

  if (APPLY) {
    if (writes.length) await Grade.bulkWrite(writes, { ordered: false });
    if (deletes.length) await Grade.deleteMany({ _id: { $in: deletes } });
  }

  console.log(
    `\n${APPLY ? "Migrated" : "Would migrate"} ${legacy.length} legacy grade row(s): ` +
      `${created} block(s) written, ${replaced} row(s) discarded as already recorded.`
  );
  await mongoose.disconnect();
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
