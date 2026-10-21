/**
 * Verify the Ghanaian terminal-report grading upgrade.
 *
 *   npm run verify:grading
 *
 * ## What it checks
 *
 *  - **A. Schema** — the grade model takes the breakdown's assessment types,
 *    refuses the truly-retired ones, and the report card accepts a half-entered
 *    subject.
 *  - **B. Arithmetic** — the 30/70 weighting, the direct class-score that
 *    rescales onto 30, the parts breakdown, the band, and the positions.
 *  - **C. The live database** — the unique index is really per assessment type
 *    on the deployed collection, and no retired vocabulary rows remain.
 *  - **D. The whole flow, end to end** — a teacher saves a class of marks as the
 *    parts of the class assessment plus the exam, the headmaster reviews and
 *    approves them, the cards are compiled and published, and the report card a
 *    parent reads carries the class score out of 30, the exam out of 100, the
 *    weighted total, the grade and the subject position.
 *
 * ## What it writes
 *
 * Section D creates a **throwaway school** — a school, two staff accounts, three
 * students, their marks and their report cards — and deletes all of it again in
 * a `finally` block, whether the run passed or failed. Nothing outside that one
 * school is touched, and the demo data is left exactly as it was found.
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
import {
  calculateTotalScore,
  normaliseClassScore,
} from "../src/utils/gradeBands.js";
import { ASSESSMENT_TYPES, CLASS_COMPONENT_KEYS } from "../src/utils/gradingConfig.js";

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
  "Grade.assessmentType enum is the split, not the old two",
  Grade.schema.path("assessmentType").enumValues.sort(),
  [...ASSESSMENT_TYPES].sort()
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
  score: 24,
  maxScore: 30,
  recordedBy: new mongoose.Types.ObjectId(),
});
const classErr = classRow.validateSync();
ok("a class_score row validates", !classErr, classErr ? classErr.message : "");

const examRow = new Grade({
  ...classRow.toObject(),
  assessmentType: "exam_score",
  score: 60,
  maxScore: 100,
});
const examErr = examRow.validateSync();
ok("an exam_score row validates", !examErr, examErr ? examErr.message : "");

// The class-score parts are on the report now; the old vocabulary that had no
// column is refused.
const legacyErr = new Grade({
  ...classRow.toObject(),
  assessmentType: "quiz",
}).validateSync();
ok("a retired assessmentType (quiz) is refused", Boolean(legacyErr));

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
      classScore: 24,
      classMaxScore: 30,
      examScore: 60,
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
      classScore: 24,
      classMaxScore: 30,
      examScore: null,
      examMaxScore: 100,
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

const total = calculateTotalScore(24, 30, 60, 100);
eq("24/30 + 60/100 is 66", total.totalScore, 66);
eq("66 is a B", total.grade, "B");
eq("the exam contributes its 42 of 70", total.examPoints, 42);
eq("the class contributes its 24 of 30", total.classPoints, 24);

ok(
  "a legacy /50 mark rescales to the same /30 proportion",
  normaliseClassScore(45, 50, { classWeight: 30 }) === 27 &&
    normaliseClassScore(27, 30, { classWeight: 30 }) === 27
);

// A full class simulation on the default breakdown (9/9/6/6).
//   s1  class 24 (24/24/16/16 → 7.2+7.2+4.8+4.8) + exam 80 → 24 + 56 = 80, grade A
//   s2  class 21 (21/21/14/14 → 6.3+6.3+4.2+4.2) + exam 65 → 21 + 46 = 67, grade B
//   s3  class 15 (15/15/10/10 → 4.5+4.5+3+3) + exam 40 → 15 + 28 = 43, grade F
//   s4  class 18/30 only — half marked, no total and no position
const rowsFor = (classScore, maxScore, examScore) => {
  const rows = [
    { subject: "English", assessmentType: "class_score", score: classScore, maxScore },
  ];
  if (examScore !== null) {
    rows.push({ subject: "English", assessmentType: "exam_score", score: examScore, maxScore: 100 });
  }
  return rows;
};
const byStudent = new Map([
  ["s1", rowsFor(24, 30, 80)],
  ["s2", rowsFor(24, 30, 60)],
  ["s4", rowsFor(18, 30, null)],
]);
const results = new Map();
for (const [id, rows] of byStudent) results.set(id, buildSubjectResults(rows));
const positions = assignSubjectPositions(results);

eq(
  "s1 total is 80 and grade A",
  [results.get("s1")[0].totalScore, results.get("s1")[0].grade],
  [80, "A"]
);
eq(
  "s2 total is 66 and grade B",
  [results.get("s2")[0].totalScore, results.get("s2")[0].grade],
  [66, "B"]
);
ok("a half-marked subject gets no position", !positions.has("s4"));
ok(
  "a half-marked subject has no total",
  results.get("s4")[0].totalScore === null && results.get("s4")[0].complete === false
);
eq("s1 is 1st, s2 is 2nd", [positions.get("s1").get("English"), positions.get("s2").get("English")], [
  "1st",
  "2nd",
]);

// The parts breakdown folds into the same class score.
const partResults = buildSubjectResults([
  { subject: "English", assessmentType: "class_test", score: 80, maxScore: 100 },
  { subject: "English", assessmentType: "group_work", score: 80, maxScore: 100 },
  { subject: "English", assessmentType: "homework", score: 16, maxScore: 20 },
  { subject: "English", assessmentType: "class_work", score: 16, maxScore: 20 },
  { subject: "English", assessmentType: "exam_score", score: 60, maxScore: 100 },
]);
eq(
  "the parts add up to the same 24/30",
  partResults[0].classScore,
  24
);
eq("the parts path totals 66", partResults[0].totalScore, 66);
eq("the parts are surfaced on the result", partResults[0].classParts.length, 4);

const drafts = [...results].map(([id, r]) => ({
  student: { _id: id },
  average: averageOfTotals(r),
  completedCount: r.filter((x) => x.complete).length,
}));
const classPositions = rankByAverage(drafts);
eq(
  "the class position is ranked and the half-marked student is not",
  [classPositions.get("s1"), classPositions.get("s2"), classPositions.has("s4")],
  [1, 2, false]
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
  const liveIndex = indexes.find((i) => i.unique && i.key?.assessmentType === 1);
  ok(
    "the live unique index is per assessment type",
    Boolean(liveIndex),
    liveIndex ? JSON.stringify(liveIndex.key) : JSON.stringify(indexes.map((i) => i.key))
  );

  const byType = await Grade.aggregate([
    { $group: { _id: "$assessmentType", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
  line(`  Grades by assessmentType: ${JSON.stringify(byType)}`);

  // Anything not on the current enum is retired vocabulary the migration should
  // already have cleared.
  const retired = await Grade.countDocuments({ assessmentType: { $nin: ASSESSMENT_TYPES } });
  eq("no retired assessment-type rows remain", retired, 0);
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

   // The teacher enters the class in one call: the four parts of the class
   // assessment and the exam, for every student. Class Test and Group Work are
   // on their default 30-mark scale (Homework/Class Work on 20), and each
   // contributes its proportion of its 9/9/6/6 share of the 30-point class.
   const bulk = await teacherService.saveBulkGrades(actor, {
     className: CLASS_NAME,
     subject: SUBJECT,
     term: TERM,
     academicYear: YEAR,
     grades: [
       { studentId: s1._id, assessmentType: "class_test", score: 24 },
       { studentId: s1._id, assessmentType: "group_work", score: 24 },
       { studentId: s1._id, assessmentType: "homework", score: 16 },
       { studentId: s1._id, assessmentType: "class_work", score: 16 },
       { studentId: s1._id, assessmentType: "exam_score", score: 80 },
       { studentId: s2._id, assessmentType: "class_test", score: 21 },
       { studentId: s2._id, assessmentType: "group_work", score: 21 },
       { studentId: s2._id, assessmentType: "homework", score: 14 },
       { studentId: s2._id, assessmentType: "class_work", score: 14 },
       { studentId: s2._id, assessmentType: "exam_score", score: 65 },
       { studentId: s3._id, assessmentType: "class_test", score: 15 },
       { studentId: s3._id, assessmentType: "group_work", score: 15 },
       { studentId: s3._id, assessmentType: "homework", score: 10 },
       { studentId: s3._id, assessmentType: "class_work", score: 10 },
       { studentId: s3._id, assessmentType: "exam_score", score: 40 },
     ],
   });
  eq("the bulk save accepted every row", bulk.errors?.length ?? 0, 0);

  const rows = await Grade.find({
    schoolId: school._id,
    className: CLASS_NAME,
    subject: SUBJECT,
  }).lean();
  eq("the database holds five rows per student", rows.length, 15);
  eq(
    "no direct class_score row is written in a parts school",
    rows.filter((r) => r.assessmentType === "class_score").length,
    0
  );
  eq(
    "the four class-assessment parts are written",
    rows.filter((r) => r.assessmentType === "class_test").length,
    3
  );
  eq(
    "each part is recorded against its own maximum",
    rows
      .filter((r) => r.assessmentType === "homework")
      .map((r) => r.maxScore),
    [20, 20, 20]
  );
  eq(
    "the exam is recorded out of 100",
    rows.filter((r) => r.assessmentType === "exam_score").map((r) => r.maxScore),
    [100, 100, 100]
  );
  eq("every row starts life as submitted", [...new Set(rows.map((r) => r.approvalStatus))], [
    "submitted",
  ]);

  // The teacher sees the same breakdown and total the grid previews.
  const teacherView = await teacherService.getClassGrades(actor, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  const teacherRows = new Map(teacherView.students.map((row) => [String(row._id), row]));
  const teacherRow = teacherRows.get(String(s1._id));
  eq("the teacher sees the class score out of 30", teacherRow?.classScore, 24);
  eq("the teacher sees the class maximum", teacherRow?.classMaxScore, 30);
  eq("the teacher sees the exam score out of 100", teacherRow?.examScore, 80);
  eq("the teacher sees the total out of 100", teacherRow?.totalScore, 80);
  eq("the teacher sees the grade", teacherRow?.grade, "A");
  eq("the teacher sees the subject position", teacherRow?.subjectPosition, "1st");
  eq(
    "the teacher sees the parts back",
    teacherRow?.classParts?.class_test?.score,
    24
  );

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

  // A correction lands on its own part.
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
    assessmentType: "class_test",
  }).lean();
  eq("the correction did not disturb the class parts", untouched[0]?.score, 24);

  // Writing a direct class score clears the parts, and vice-versa — two class
  // scores on one subject would make the reader guess which one to print.
  await teacherService.saveSingleGrade(actor, {
    studentId: s3._id,
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
    assessmentType: "class_score",
    score: 21,
  });
  const s3Direct = await Grade.find({
    schoolId: school._id,
    studentId: s3._id,
    assessmentType: "class_score",
  }).lean();
  eq("s3 now has a single direct class score, out of 30", s3Direct.length, 1);
  eq("the direct class score is recorded on 30", s3Direct[0].maxScore, 30);
  const s3Parts = await Grade.find({
    schoolId: school._id,
    studentId: s3._id,
    assessmentType: { $in: CLASS_COMPONENT_KEYS },
  }).lean();
  eq("writing a class score cleared s3's parts", s3Parts.length, 0);
  const teacherViewS3 = teacherRows.get(String(s3._id));
  void teacherViewS3;
  const afterSwitch = await teacherService.getClassGrades(actor, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  const switched = afterSwitch.students.find((r) => String(r._id) === String(s3._id));
  eq(
    "s3's class score is the direct 21/30, normalised",
    switched?.classScore,
    21
  );
  eq("s3's parts are gone after the switch", switched?.classParts?.class_test?.score, null);

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
  eq("the admin sees the class score out of 30", adminRow?.classScore, 24);
  eq("the admin sees the class maximum", adminRow?.classMaxScore, 30);
  eq(
    "the admin sees the class-assessment parts",
    (adminRow?.classParts || []).length,
    4
  );
  eq("the admin sees the exam score out of 100", adminRow?.examScore, 78);
  eq("the admin sees the exam maximum", adminRow?.examMaxScore, 100);
  eq("the admin sees the exam's 55 of 70", adminRow?.examPoints, 55);
  eq("the admin sees the total out of 100", adminRow?.totalScore, 79);
  eq("the admin sees the grade", adminRow?.grade, "A-");
  eq("the admin sees the subject position", adminRow?.subjectPosition, "1st");
  eq("the admin sees the approval state", adminRow?.approvalStatus, "submitted");

  // The headmaster approves the block.
  const approved = await approval.approveClassGrades(school._id, admin._id, {
    className: CLASS_NAME,
    subject: SUBJECT,
    term: TERM,
    academicYear: YEAR,
  });
  ok("the approval moved the block", typeof approved?.approved === "number");
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
  eq("the card carries the class score", subject?.classScore, 24);
  eq("the card carries the class maximum", subject?.classMaxScore, 30);
  eq("the card carries the exam score", subject?.examScore, 78);
  eq("the card carries the exam maximum", subject?.examMaxScore, 100);
  eq("the card carries the total out of 100", subject?.totalScore, 79);
  eq("the card carries the grade", subject?.grade, "A-");
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
    parentSubject?.classScore === 24 &&
      parentSubject?.examScore === 78 &&
      parentSubject?.totalScore === 79 &&
      parentSubject?.subjectPosition === "1st",
    JSON.stringify(parentSubject)
  );

  // A half-marked subject is not a fail — it has no total, no grade, no position.
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
    term: TERM,
    academicYear: YEAR,
  }).lean();
  const halfCard = recompiled.find((c) => String(c.studentId) === String(s3._id));
  const halfSubject = halfCard?.subjects?.[0];
  eq("a half-marked subject has no total", halfSubject?.totalScore, null);
  eq("a half-marked subject has no grade", halfSubject?.grade, "");
  eq("a half-marked subject has no subject position", halfSubject?.subjectPosition, "");
  ok(
    "a half-marked student is excluded from the class position",
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
