/**
 * Verify the Ghanaian terminal-report grading upgrade.
 *
 *   npm run verify:grading
 *
 * ## What it checks
 *
 *  - **A. Schema** — the grade model takes the two assessment types, refuses
 *    the legacy one, and the report card accepts a half-entered subject.
 *  - **B. Arithmetic** — the two halves normalise onto 50 each, the total is
 *    out of 100, the band follows, and the positions are competition-ranked.
 *  - **C. The live database** — the unique index is really per assessment type
 *    on the deployed collection, not just in the schema.
 *  - **D. The whole flow, end to end** — a teacher saves a class of marks, the
 *    headmaster reviews and approves them, the cards are compiled and
 *    published, and the report card a parent reads carries the class score,
 *    the exam score, the total, the grade and the subject position.
 *
 * ## What it writes
 *
 * Section D creates a **throwaway school** — a school, two staff accounts,
 * three students, their marks and their report cards — and deletes all of it
 * again in a `finally` block, whether the run passed or failed. Nothing
 * outside that one school is touched, and the demo data is left exactly as it
 * was found.
 *
 * The live checks need `MONGODB_URI`; without it the run stops after the
 * arithmetic and says so.
 */
import mongoose from "mongoose";
import { MONGODB_URI } from "../src/config/env.js";
import { Grade } from "../src/models/Grade.js";
import { ReportCard } from "../src/models/ReportCard.js";
import { School } from "../src/models/schoolModel.js";
import { User } from "../src/models/userModel.js";
import { Student } from "../src/models/studentModel.js";
import { AuditLog } from "../src/models/AuditLog.js";
import { Attendance } from "../src/models/Attendance.js";
import {
  buildSubjectResults,
  assignSubjectPositions,
  averageOfTotals,
  rankByAverage,
} from "../src/utils/subjectResults.js";
import { calculateTotalScore } from "../src/utils/gradeBands.js";

const teacherService = await import("../src/services/teacher/grades.service.js");
const adminGrades = await import("../src/services/admin/classGrades.service.js");
const approval = await import("../src/services/admin/gradeApproval.service.js");
const records = await import("../src/services/admin/recordsApproval.service.js");

let passed = 0;
let failed = 0;

const line = (text) => console.log(text);
const ok = (label, condition, detail = "") => {
  if (condition) {
    passed += 1;
    line(`PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    failed += 1;
    line(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
};
const eq = (label, actual, expected) =>
  ok(
    label,
    JSON.stringify(actual) === JSON.stringify(expected),
    `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`
  );

// ── A. Schema ──────────────────────────────────────────────────────────────

line("\n═══ A. Schema (no database) ═══\n");

eq(
  "Grade.assessmentType enum is [class_score, exam_score]",
  Grade.schema.path("assessmentType").enumValues,
  ["class_score", "exam_score"]
);

const unique = Grade.schema.indexes().find(
  ([keys, opts]) => opts?.unique === true && keys.assessmentType === 1
);
ok(
  "the unique index keys on assessmentType",
  Boolean(unique),
  unique ? JSON.stringify(unique[0]) : "missing"
);

const classRow = new Grade({
  schoolId: new mongoose.Types.ObjectId(),
  studentId: new mongoose.Types.ObjectId(),
  className: "JHS 2A",
  subject: "English",
  term: "Term 2",
  academicYear: "2026/2027",
  assessmentType: "class_score",
  score: 42,
  maxScore: 50,
  recordedBy: new mongoose.Types.ObjectId(),
});
const classErr = classRow.validateSync();
ok("a class_score row validates", !classErr, classErr ? classErr.message : "");

const examRow = new Grade({
  ...classRow.toObject(),
  assessmentType: "exam_score",
  score: 48,
  maxScore: 100,
});
const examErr = examRow.validateSync();
ok("an exam_score row validates", !examErr, examErr ? examErr.message : "");

// A legacy row must NOT validate — that is what the migration exists for.
const legacyErr = new Grade({
  ...classRow.toObject(),
  assessmentType: "class_test",
}).validateSync();
ok("a legacy assessmentType is refused", Boolean(legacyErr));

// The report card must accept a complete subject AND a half-entered one.
const card = new ReportCard({
  schoolId: new mongoose.Types.ObjectId(),
  studentId: new mongoose.Types.ObjectId(),
  className: "JHS 2A",
  term: "Term 2",
  academicYear: "2026/2027",
  subjects: [
    {
      subject: "English",
      classScore: 42,
      classMaxScore: 50,
      examScore: 48,
      examMaxScore: 100,
      totalScore: 66,
      grade: "B",
      meaning: "Developing",
      subjectPosition: "2nd",
      score: 66,
      maxScore: 100,
    },
    {
      subject: "Mathematics",
      classScore: 30,
      classMaxScore: 50,
      examScore: null,
      totalScore: null,
      grade: "",
      score: null,
    },
  ],
});
const cardErr = card.validateSync();
ok(
  "a card with a complete and a half-entered subject validates",
  !cardErr,
  cardErr ? cardErr.message : ""
);

// ── B. Arithmetic ──────────────────────────────────────────────────────────

line("\n═══ B. Arithmetic ═══\n");

const total = calculateTotalScore(42, 50, 48, 100);
eq("42/50 + 48/100 is 66", total.totalScore, 66);
eq("66 is a B", total.grade, "B");

// Three students, one subject, a full class simulation.
//   s1  45/50 + 80/100 → 45 + 40 = 85
//   s3  50/50 + 60/100 → 50 + 30 = 80
//   s2  42/50 + 48/100 → 42 + 24 = 66
//   s4  class score only — half marked, so no total and no position
const rowsFor = (classScore, examScore) => {
  const rows = [
    { subject: "English", assessmentType: "class_score", score: classScore, maxScore: 50 },
  ];
  if (examScore !== null) {
    rows.push({ subject: "English", assessmentType: "exam_score", score: examScore, maxScore: 100 });
  }
  return rows;
};
const byStudent = new Map([
  ["s1", rowsFor(45, 80)],
  ["s2", rowsFor(42, 48)],
  ["s3", rowsFor(50, 60)],
  ["s4", rowsFor(30, null)],
]);
const results = new Map();
for (const [id, rows] of byStudent) results.set(id, buildSubjectResults(rows));
const positions = assignSubjectPositions(results);

eq(
  "the subject positions are 1st/2nd/3rd",
  ["s1", "s3", "s2"].map((id) => positions.get(id).get("English")),
  ["1st", "2nd", "3rd"]
);
ok("a half-marked subject gets no position", !positions.has("s4"));
ok(
  "a half-marked subject has no total",
  results.get("s4")[0].totalScore === null && results.get("s4")[0].complete === false
);
eq("s1's total is 85", results.get("s1")[0].totalScore, 85);
eq("s2's total is 66 and its grade is B", [
  results.get("s2")[0].totalScore,
  results.get("s2")[0].grade,
], [66, "B"]);

const drafts = [...results].map(([id, r]) => ({
  student: { _id: id },
  average: averageOfTotals(r),
  completedCount: r.filter((x) => x.complete).length,
}));
const classPositions = rankByAverage(drafts);
eq(
  "the class position is ranked too, and the half-marked student is not",
  [classPositions.get("s1"), classPositions.get("s3"), classPositions.get("s2"), classPositions.has("s4")],
  [1, 2, 3, false]
);

if (!MONGODB_URI) {
  line("\nNo MONGODB_URI — skipping the live-database checks.\n");
  line(`${passed} passed, ${failed} failed.\n`);
  process.exit(failed ? 1 : 0);
}

// ── C. The live database ───────────────────────────────────────────────────

line("\n═══ C. Live database (read-only) ═══\n");

try {
  await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  line(`Connected to "${mongoose.connection.name}"`);

  const indexes = await Grade.collection.indexes();
  const live = indexes.find((i) => i.unique && i.key?.assessmentType === 1);
  ok(
    "the live unique index is per assessment type",
    Boolean(live),
    live ? JSON.stringify(live.key) : JSON.stringify(indexes.map((i) => i.key))
  );

  const byType = await Grade.aggregate([
    { $group: { _id: "$assessmentType", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  line(`  Grades by assessmentType: ${JSON.stringify(byType)}`);

  const legacyCount = await Grade.countDocuments({
    assessmentType: { $in: ["class_test", "quiz", "assignment", "exam"] },
  });
  line(`  Rows still needing the migration: ${legacyCount}`);
} catch (error) {
  failed += 1;
  line(`FAIL  the live database check threw — ${error.message}`);
}

// ── D. The whole flow, end to end ──────────────────────────────────────────

line("\n═══ D. End to end: teacher → headmaster → report card ═══\n");

const CLASS_NAME = "ZZ Verify 1A";
const SUBJECT = "English";
const TERM = "Term 2";
const YEAR = "2026/2027";
let throwawaySchoolId = null;

try {
  const stamp = Date.now();

  const school = await School.create({
    name: "ZZ Verification School",
    slug: `zz-verify-school-${stamp}`,
    schoolCode: `ZZVER-${stamp}`,
    type: "private",
    phone: "0200000000",
    email: `zz-verify-${stamp}@example.test`,
    address: "1 Test Street",
    city: "Accra",
    region: "Greater Accra",
    createdBy: new mongoose.Types.ObjectId(),
    academic: { currentTerm: TERM, currentYear: "2026", classes: [CLASS_NAME] },
  });
  throwawaySchoolId = school._id;

  const teacher = await User.create({
    name: "ZZ Verification Teacher",
    email: `zz-verify-teacher-${stamp}@example.test`,
    password: "NotARealPassword1!",
    role: "teacher",
    schoolId: school._id,
    assignedClasses: [{ className: CLASS_NAME, subject: SUBJECT }],
  });

  const admin = await User.create({
    name: "ZZ Verification Admin",
    email: `zz-verify-admin-${stamp}@example.test`,
    password: "NotARealPassword1!",
    role: "school_admin",
    schoolId: school._id,
  });

  const students = await Student.create(
    [
      { studentName: "Verify One", studentClass: CLASS_NAME, academicYear: YEAR },
      { studentName: "Verify Two", studentClass: CLASS_NAME, academicYear: YEAR },
      { studentName: "Verify Three", studentClass: CLASS_NAME, academicYear: YEAR },
    ].map((row) => ({
      ...row,
      schoolId: school._id,
      studentId: `ZZVER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
      status: "active",
      deletedAt: null,
      gender: "male",
      totalOwed: 0,
      deadline: new Date("2026-12-31T00:00:00Z"),
      createdBy: admin._id,
      parents: [
        {
          parentName: "ZZ Verification Parent",
          relationship: "father",
          phone: "0200000001",
        },
      ],
    }))
  );
  const [s1, s2, s3] = students;

  const actor = {
    _id: teacher._id,
    role: "teacher",
    name: teacher.name,
    schoolId: school._id,
    assignedClasses: teacher.assignedClasses,
  };

  // The teacher enters the class in one call: both halves for every student.
  const bulk = await teacherService.saveBulkGrades(actor, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
    grades: [
      { studentId: s1._id, assessmentType: "class_score", score: 45 },
      { studentId: s1._id, assessmentType: "exam_score", score: 80 },
      { studentId: s2._id, assessmentType: "class_score", score: 35 },
      { studentId: s2._id, assessmentType: "exam_score", score: 55 },
      { studentId: s3._id, assessmentType: "class_score", score: 40 },
      { studentId: s3._id, assessmentType: "exam_score", score: 70 },
    ],
  });
  eq("the bulk save accepted every row", bulk.errors?.length ?? 0, 0);

  const rows = await Grade.find({
    schoolId: school._id,
    className: CLASS_NAME,
    subject: SUBJECT,
  }).lean();
  eq("the database holds one class_score and one exam_score per student", rows.length, 6);
  eq(
    "the class score is recorded out of 50",
    rows.filter((r) => r.assessmentType === "class_score").map((r) => r.maxScore),
    [50, 50, 50]
  );
  eq(
    "the exam score is recorded out of 100",
    rows.filter((r) => r.assessmentType === "exam_score").map((r) => r.maxScore),
    [100, 100, 100]
  );
  eq("every row starts life as submitted", [...new Set(rows.map((r) => r.approvalStatus))], [
    "submitted",
  ]);

  // The teacher sees the breakdown while they are still typing.
  const teacherView = await teacherService.getClassGrades(actor, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  const teacherRows = new Map(teacherView.students.map((row) => [String(row._id), row]));
  const teacherRow = teacherRows.get(String(s1._id));
  eq("the teacher sees the class score out of 50", teacherRow?.classScore, 45);
  eq("the teacher sees the exam score out of 100", teacherRow?.examScore, 80);
  eq("the teacher sees the total out of 100", teacherRow?.totalScore, 85);
  eq("the teacher sees the grade", teacherRow?.grade, "A");
  eq("the teacher sees the subject position", teacherRow?.subjectPosition, "1st");

  // The grid is rendered before a subject is chosen. It must show no marks
  // then, not one arbitrary subject's marks.
  const noSubject = await teacherService.getClassGrades(actor, {
    className: CLASS_NAME,
    term: TERM,
    academicYear: YEAR,
  });
  eq(
    "a read with no subject returns the roster with no scores",
    noSubject.students.map((s) => [s.classScore, s.examScore, s.totalScore]),
    [
      [null, null, null],
      [null, null, null],
      [null, null, null],
    ]
  );

  // A correction lands on its own half of the subject.
  await teacherService.saveSingleGrade(actor, {
    studentId: s1._id,
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
    assessmentType: "exam_score",
    score: 78,
  });
  const corrected = await Grade.find({
    schoolId: school._id,
    studentId: s1._id,
    assessmentType: "exam_score",
  }).lean();
  eq("a single save updates the exam row in place", corrected.length, 1);
  eq("the corrected exam score is stored", corrected[0].score, 78);
  const untouched = await Grade.find({
    schoolId: school._id,
    studentId: s1._id,
    assessmentType: "class_score",
  }).lean();
  eq("the correction did not disturb the class score", untouched[0].score, 45);

  // The headmaster reviews the same breakdown.
  const adminView = await adminGrades.getAdminClassGrades(school._id, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  const adminRows = adminView.grades || [];
  const adminRow = adminRows.find((r) => String(r.studentId) === String(s1._id));
  eq("the admin preview returns a row per student and subject", adminRows.length, 3);
  ok(
    "the admin preview identifies students by their real id",
    !adminRows.some((r) => r.studentId === "[object Object]"),
    adminRows.map((r) => r.studentId).join(", ")
  );
  eq("the admin sees the class score out of 50", adminRow?.classScore, 45);
  eq("the admin sees the exam score out of 100", adminRow?.examScore, 78);
  eq("the admin sees the total out of 100", adminRow?.totalScore, 84);
  eq("the admin sees the grade", adminRow?.grade, "A");
  eq("the admin sees the subject position", adminRow?.subjectPosition, "1st");
  eq("the admin sees the approval state", adminRow?.approvalStatus, "submitted");

  // The headmaster approves the block.
  const approved = await approval.approveClassGrades(school._id, admin._id, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  ok("the approval moved the block", Boolean(approved), JSON.stringify(approved));
  const afterApproval = await Grade.find({
    schoolId: school._id,
    className: CLASS_NAME,
    subject: SUBJECT,
  }).lean();
  eq("every row is now approved", [...new Set(afterApproval.map((r) => r.approvalStatus))], [
    "approved",
  ]);

  // The compile writes the report card.
  const compiled = await records.compileClassReportsFromGrades(school._id, admin._id, {
    className: CLASS_NAME,
    term: TERM,
    academicYear: YEAR,
  });
  eq("the compile produced one card per student", compiled.compiled, 3);

  const cards = await ReportCard.find({
    schoolId: school._id,
    className: CLASS_NAME,
    term: TERM,
    academicYear: YEAR,
  }).lean();
  eq("three report cards exist", cards.length, 3);
  const cardRow = cards.find((c) => String(c.studentId) === String(s1._id));
  const subject = cardRow?.subjects?.[0];
  eq("the card carries the class score", subject?.classScore, 45);
  eq("the card carries the class maximum", subject?.classMaxScore, 50);
  eq("the card carries the exam score", subject?.examScore, 78);
  eq("the card carries the exam maximum", subject?.examMaxScore, 100);
  eq("the card carries the total out of 100", subject?.totalScore, 84);
  eq("the card carries the grade", subject?.grade, "A");
  eq("the card carries the subject position", subject?.subjectPosition, "1st");
  eq("the card carries the subject name", subject?.subject, SUBJECT);
  ok("the card has a class position", cardRow?.position != null, `position ${cardRow?.position}`);
  eq("the card knows the class size", cardRow?.classSize, 3);

  // The cards are published for the parents.
  const published = await records.publishClassReports(school._id, admin._id, {
    className: CLASS_NAME,
    term: TERM,
    academicYear: YEAR,
  });
  ok("the publish went through", Boolean(published), JSON.stringify(published).slice(0, 160));
  const afterPublish = await ReportCard.find({
    schoolId: school._id,
    className: CLASS_NAME,
  }).lean();
  eq("every card is published", [...new Set(afterPublish.map((c) => c.status))], ["published"]);

  // What the parent reads.
  const parentCard = afterPublish.find((c) => String(c.studentId) === String(s1._id));
  const parentSubject = (parentCard?.subjects || [])[0];
  ok(
    "the parent sees both halves, the total and the position",
    parentSubject?.classScore === 45 &&
      parentSubject?.examScore === 78 &&
      parentSubject?.totalScore === 84 &&
      parentSubject?.subjectPosition === "1st",
    JSON.stringify(parentSubject)
  );

  // A half-marked subject is not a fail.
  await Grade.deleteMany({
    schoolId: school._id,
    studentId: s3._id,
    assessmentType: "exam_score",
  });
  await approval.approveClassGrades(school._id, admin._id, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  await records.compileClassReportsFromGrades(school._id, admin._id, {
    className: CLASS_NAME,
    term: TERM,
    academicYear: YEAR,
  });
  const recompiled = await ReportCard.find({
    schoolId: school._id,
    className: CLASS_NAME,
  }).lean();
  const halfCard = recompiled.find((c) => String(c.studentId) === String(s3._id));
  const halfSubject = halfCard?.subjects?.[0];
  eq("a half-marked subject has no total", halfSubject?.totalScore, null);
  eq("a half-marked subject has no grade", halfSubject?.grade, "");
  eq("a half-marked subject has no position", halfSubject?.subjectPosition, "");
  ok(
    "a half-marked subject is excluded from the class position",
    halfCard?.position == null,
    `position ${halfCard?.position}`
  );
} catch (error) {
  failed += 1;
  line(`FAIL  the end-to-end run threw — ${error.message}`);
  console.error(error);
} finally {
  if (throwawaySchoolId) {
    const oid = new mongoose.Types.ObjectId(String(throwawaySchoolId));
    // Each delete is independent: one collection refusing to be cleaned must
    // not leave the rest of the throwaway school behind.
    const collections = [Grade, ReportCard, Attendance, AuditLog, Student, User];
    for (const model of collections) {
      await model.deleteMany({ schoolId: oid }).catch((error) => {
        line(`  Could not clear ${model.collection.name}: ${error.message}`);
      });
    }
    await School.deleteOne({ _id: oid }).catch((error) => {
      line(`  Could not remove the throwaway school: ${error.message}`);
    });
    line("\nCleaned up the throwaway school and everything under it.");
  }
  await mongoose.disconnect().catch(() => {});
}

line(`\n${passed} passed, ${failed} failed.\n`);
process.exit(failed ? 1 : 0);
