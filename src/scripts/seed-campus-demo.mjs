/**
 * Campus-tier demo seed (Wave 2, Agent 1).
 *
 * Run:
 *   node src/scripts/seed-campus-demo.mjs
 *
 * Populates demo schools (schoolCode matching /^SCH-DEMO/i or tagged "demo") with
 * rich campus-tier data so the Campus features have something to show:
 *
 *   - 3 campuses per demo school: Main / North / South (code MAIN, NORTH, SOUTH).
 *   - Existing demo students spread deterministically across those campuses.
 *   - A demo DisbursementBatch with requiredSignatures: 2, pending_approval.
 *   - A demo ReportTemplate of type moe_compliance.
 *   - Demo LMS documents with mixed campusId (some null/school-wide, some
 *     campus-specific).
 *
 * Idempotent: campuses are upserted on { schoolId, code }, and every other
 * artifact is looked up by a stable key (batch number, template type, LMS title)
 * and skipped when it already exists. Re-running is a no-op.
 *
 * Exits 0 on success (including "no demo schools found"), 1 on failure.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../config/env.js';
import { School } from '../models/schoolModel.js';
import { Campus } from '../models/Campus.js';
import { User } from '../models/userModel.js';
import { Student } from '../models/studentModel.js';
import { DisbursementBatch } from '../models/DisbursementBatch.js';
import { ReportTemplate } from '../models/ReportTemplate.js';
import { LmsItem } from '../models/LmsItem.js';
import { LmsLesson } from '../models/LmsLesson.js';
import { LmsAssessment } from '../models/LmsAssessment.js';
import { LmsResource } from '../models/LmsResource.js';
import { LmsStudyPlan } from '../models/LmsStudyPlan.js';
import { LmsSubmission } from '../models/LmsSubmission.js';

const CAMPUS_DEFS = [
  { name: 'Main Campus', code: 'MAIN' },
  { name: 'North Campus', code: 'NORTH' },
  { name: 'South Campus', code: 'SOUTH' },
];

const isDemoSchool = (school) =>
  (!!school.schoolCode && /^SCH-DEMO/i.test(school.schoolCode)) ||
  (Array.isArray(school.tags) && school.tags.some((t) => String(t).toLowerCase() === 'demo'));

const upsertCampuses = async (school) => {
  const campuses = [];
  for (const def of CAMPUS_DEFS) {
    // eslint-disable-next-line no-await-in-loop
    const campus = await Campus.findOneAndUpdate(
      { schoolId: school._id, code: def.code },
      {
        $setOnInsert: {
          schoolId: school._id,
          name: def.name,
          code: def.code,
          status: 'active',
          createdBy: school.createdBy,
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    campuses.push(campus);
  }
  return campuses;
};

const assignStudents = async (school, campuses, hqId) => {
  const students = await Student.find({
    schoolId: school._id,
    campusId: { $in: [null, hqId] },
  })
    .select('_id')
    .sort({ _id: 1 })
    .lean();

  if (!students.length) return 0;

  const buckets = campuses.map(() => []);
  students.forEach((student, index) => {
    buckets[index % campuses.length].push(student._id);
  });

  let assigned = 0;
  for (let i = 0; i < campuses.length; i += 1) {
    if (!buckets[i].length) continue;
    // eslint-disable-next-line no-await-in-loop
    await Student.updateMany(
      { _id: { $in: buckets[i] } },
      { $set: { campusId: campuses[i]._id } }
    );
    assigned += buckets[i].length;
  }
  return assigned;
};

const seedDisbursement = async (school, campusId) => {
  const batchNumber = `DISB-DEMO-${(school.schoolCode || String(school._id)).toUpperCase()}`;
  const existing = await DisbursementBatch.findOne({ batchNumber }).select('_id').lean();
  if (existing) return { created: false, batchNumber };

  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);

  const grossAmount = 5000000; // GHS 50,000.00 in pesewas
  const platformAmount = 75000; // 1.5% markup
  const netAmount = grossAmount - platformAmount;

  await DisbursementBatch.create({
    batchNumber,
    schoolId: school._id,
    campusId,
    periodStart,
    periodEnd,
    status: 'pending_approval',
    requiredSignatures: 2,
    signatureCount: 0,
    signatures: [],
    grossAmount,
    platformAmount,
    netAmount,
    paymentCount: 0,
    paymentIds: [],
    breakdown: {
      markupAmount: platformAmount,
      platformFeeAmount: 0,
      markupPercent: 1.5,
      platformFeePercent: 0,
    },
    createdBy: school.createdBy,
  });

  return { created: true, batchNumber };
};

const seedReportTemplate = async (school) => {
  const existing = await ReportTemplate.findOne({
    schoolId: school._id,
    type: 'moe_compliance',
  })
    .select('_id')
    .lean();
  if (existing) return false;

  await ReportTemplate.create({
    schoolId: school._id,
    name: 'MoE Compliance Report (Demo)',
    type: 'moe_compliance',
    format: 'csv',
    moeCompliant: true,
    parameters: {},
    createdBy: school.createdBy,
  });
  return true;
};

const seedLms = async (school, teacherId, campuses) => {
  const campusA = campuses[0]._id;
  const campusB = campuses[1]._id;
  let created = 0;

  const ensureItem = async (Model, title, data) => {
    // eslint-disable-next-line no-await-in-loop
    const existing = await Model.exists({ schoolId: school._id, title });
    if (existing) return false;
    // eslint-disable-next-line no-await-in-loop
    await Model.create({ schoolId: school._id, ...data });
    return true;
  };

  if (
    await ensureItem(LmsItem, '[Demo] School-wide Lesson', {
      campusId: null,
      teacherId,
      sharingScope: 'school',
      type: 'lesson',
      title: '[Demo] School-wide Lesson',
      description: 'Visible to every campus in the school.',
      content: 'Demo school-wide lesson content.',
    })
  )
    created += 1;

  if (
    await ensureItem(LmsItem, '[Demo] Main Campus Resource', {
      campusId: campusA,
      teacherId,
      sharingScope: 'campus',
      type: 'resource',
      title: '[Demo] Main Campus Resource',
      description: 'Only the Main Campus sees this.',
      content: 'Demo campus-scoped resource.',
    })
  )
    created += 1;

  if (
    await ensureItem(LmsLesson, '[Demo] North Campus Lesson', {
      campusId: campusB,
      teacherId,
      title: '[Demo] North Campus Lesson',
      content: 'Demo lesson for the North Campus.',
      assignedClasses: [],
      assignedStudents: [],
    })
  )
    created += 1;

  if (
    await ensureItem(LmsAssessment, '[Demo] School-wide Assessment', {
      campusId: null,
      teacherId,
      title: '[Demo] School-wide Assessment',
      description: 'Open to all campuses.',
      questions: [
        {
          type: 'mcq',
          prompt: 'What is 2 + 2?',
          options: ['3', '4', '5'],
          correctAnswer: '4',
          points: 1,
        },
      ],
      assignedClasses: [],
      assignedStudents: [],
    })
  )
    created += 1;

  if (
    await ensureItem(LmsResource, '[Demo] South Campus Resource', {
      campusId: campuses[2]._id,
      teacherId,
      title: '[Demo] South Campus Resource',
      url: 'https://example.com/demo-south-resource',
      description: 'Only the South Campus sees this.',
      assignedClasses: [],
      assignedStudents: [],
    })
  )
    created += 1;

  if (
    await ensureItem(LmsStudyPlan, '[Demo] School-wide Study Plan', {
      campusId: null,
      teacherId,
      title: '[Demo] School-wide Study Plan',
      description: 'Term plan shared across all campuses.',
      lessons: [
        { title: 'Week 1', content: 'Introduction', resources: [] },
        { title: 'Week 2', content: 'Practice', resources: [] },
      ],
      assignedClasses: [],
      assignedStudents: [],
    })
  )
    created += 1;

  const assessment = await LmsAssessment.findOne({
    schoolId: school._id,
    title: '[Demo] School-wide Assessment',
  })
    .select('_id')
    .lean();
  const student = await Student.findOne({ schoolId: school._id }).select('_id').lean();

  if (assessment && student) {
    const title = '[Demo] Campus Submission';
    const existing = await LmsSubmission.exists({ schoolId: school._id, assessmentId: assessment._id, studentId: student._id });
    if (!existing) {
      await LmsSubmission.create({
        schoolId: school._id,
        campusId: campusA,
        assessmentId: assessment._id,
        studentId: student._id,
        answers: [{ questionIndex: 0, answer: '4' }],
        status: 'submitted',
      });
      created += 1;
    }
  }

  return created;
};

const run = async () => {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Add it to Backend/.env before running.');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('[campus-seed] connected to MongoDB');

  const demoSchools = await School.find({ deletedAt: null }).lean();
  const targets = demoSchools.filter(isDemoSchool);

  if (!targets.length) {
    console.log('[campus-seed] no demo schools found (schoolCode /^SCH-DEMO/i or tagged "demo"). Nothing to seed.');
    await mongoose.disconnect();
    return { schools: 0 };
  }

  const summary = {
    schools: 0,
    campuses: 0,
    studentsAssigned: 0,
    disbursementsCreated: 0,
    reportTemplatesCreated: 0,
    lmsCreated: 0,
  };

  for (const school of targets) {
    const label = school.schoolCode || String(school._id);

    const campuses = await upsertCampuses(school);
    summary.campuses += campuses.length;

    const hq = await Campus.findOne({ schoolId: school._id, code: 'HQ' }).select('_id').lean();
    const assigned = await assignStudents(school, campuses, hq?._id ?? null);
    summary.studentsAssigned += assigned;

    const disbursement = await seedDisbursement(school, campuses[0]._id);
    if (disbursement.created) summary.disbursementsCreated += 1;

    const reportCreated = await seedReportTemplate(school);
    if (reportCreated) summary.reportTemplatesCreated += 1;

    let teacher = await User.findOne({ schoolId: school._id, role: 'teacher' }).select('_id').lean();
    if (!teacher) teacher = { _id: school.createdBy };

    const lmsCreated = await seedLms(school, teacher._id, campuses);
    summary.lmsCreated += lmsCreated;

    summary.schools += 1;
    console.log(
      `[campus-seed] ${label}: ${campuses.length} campuses, ${assigned} students assigned, ` +
        `disbursement ${disbursement.created ? 'created' : 'exists'}, ` +
        `report template ${reportCreated ? 'created' : 'exists'}, ${lmsCreated} LMS item(s) created`
    );
  }

  console.log('\n[campus-seed] summary');
  console.log(`  demo schools .................... ${summary.schools}`);
  console.log(`  campuses ensured .............. ${summary.campuses}`);
  console.log(`  students assigned ............. ${summary.studentsAssigned}`);
  console.log(`  disbursements created ......... ${summary.disbursementsCreated}`);
  console.log(`  report templates created ...... ${summary.reportTemplatesCreated}`);
  console.log(`  LMS items created ............. ${summary.lmsCreated}`);

  await mongoose.disconnect();
  return summary;
};

run()
  .then(() => {
    console.log('[campus-seed] done.');
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[campus-seed] failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });