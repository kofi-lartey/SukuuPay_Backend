/**
 * Campus-tier data migration (Wave 2, Agent 1).
 *
 * Run:
 *   node src/scripts/migrate-campus-data.mjs
 *
 * One-shot backfill that introduces the Campus concept to an existing database
 * without changing any current behaviour:
 *
 *   1. Every live School gets a default "Headquarters" Campus (code "HQ").
 *   2. Every Student, Payment and DisbursementBatch that has no campusId is
 *      pinned to its school's Headquarters campus.
 *   3. Every LMS document (LmsItem, LmsLesson, LmsAssessment, LmsResource,
 *      LmsStudyPlan, LmsSubmission) is normalised to campusId: null — existing
 *      LMS content is school-wide, not campus-scoped.
 *   4. School.financialControls.multiSignatory is set to false (opt-in): the
 *      default single-signature behaviour every school already runs.
 *
 * Idempotent: each step filters to documents that still need it, so a re-run is
 * a no-op. Soft-deleted schools (deletedAt set) are skipped.
 *
 * Logs a summary (schools processed, campuses created, records backfilled) and
 * exits 0 on success, 1 on failure.
 */
import mongoose from 'mongoose';
import { MONGODB_URI } from '../config/env.js';
import { School } from '../models/schoolModel.js';
import { Campus } from '../models/Campus.js';
import { Student } from '../models/studentModel.js';
import { Payment } from '../models/paymentModel.js';
import { DisbursementBatch } from '../models/DisbursementBatch.js';
import { LmsItem } from '../models/LmsItem.js';
import { LmsLesson } from '../models/LmsLesson.js';
import { LmsAssessment } from '../models/LmsAssessment.js';
import { LmsResource } from '../models/LmsResource.js';
import { LmsStudyPlan } from '../models/LmsStudyPlan.js';
import { LmsSubmission } from '../models/LmsSubmission.js';

const HQ_NAME = 'Headquarters';
const HQ_CODE = 'HQ';

const LMS_MODELS = [
  ['LmsItem', LmsItem],
  ['LmsLesson', LmsLesson],
  ['LmsAssessment', LmsAssessment],
  ['LmsResource', LmsResource],
  ['LmsStudyPlan', LmsStudyPlan],
  ['LmsSubmission', LmsSubmission],
];

const run = async () => {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not set. Add it to Backend/.env before running.');
  }

  await mongoose.connect(MONGODB_URI);
  console.log('[campus-migration] connected to MongoDB');

  const summary = {
    schoolsProcessed: 0,
    campusesCreated: 0,
    studentsBackfilled: 0,
    paymentsBackfilled: 0,
    disbursementBatchesBackfilled: 0,
    lmsBackfilled: 0,
    schoolsMultiSignatorySet: 0,
  };

  const schools = await School.find({ deletedAt: null })
    .select('_id schoolCode name createdBy')
    .lean();

  for (const school of schools) {
    const label = school.schoolCode || String(school._id);

    let hq = await Campus.findOne({ schoolId: school._id, code: HQ_CODE })
      .select('_id')
      .lean();

    if (!hq) {
      hq = await Campus.create({
        schoolId: school._id,
        name: HQ_NAME,
        code: HQ_CODE,
        status: 'active',
        createdBy: school.createdBy,
      });
      summary.campusesCreated += 1;
      console.log(`[campus-migration] ${label}: created Headquarters campus ${hq._id}`);
    }

    const students = await Student.updateMany(
      { schoolId: school._id, campusId: null },
      { $set: { campusId: hq._id } }
    );
    summary.studentsBackfilled += students.modifiedCount;

    const payments = await Payment.updateMany(
      { schoolId: school._id, campusId: null },
      { $set: { campusId: hq._id } }
    );
    summary.paymentsBackfilled += payments.modifiedCount;

    const batches = await DisbursementBatch.updateMany(
      { schoolId: school._id, campusId: null },
      { $set: { campusId: hq._id } }
    );
    summary.disbursementBatchesBackfilled += batches.modifiedCount;

    for (const [name, Model] of LMS_MODELS) {
      const res = await Model.updateMany(
        {
          schoolId: school._id,
          $or: [{ campusId: { $exists: false } }, { campusId: { $ne: null } }],
        },
        { $set: { campusId: null } }
      );
      summary.lmsBackfilled += res.modifiedCount;
      if (res.modifiedCount) {
        console.log(
          `[campus-migration] ${label}: ${res.modifiedCount} ${name} record(s) set school-wide (campusId null)`
        );
      }
    }

    summary.schoolsProcessed += 1;
  }

  const fc = await School.updateMany(
    { deletedAt: null, 'financialControls.multiSignatory': { $ne: false } },
    { $set: { 'financialControls.multiSignatory': false } }
  );
  summary.schoolsMultiSignatorySet = fc.modifiedCount;

  console.log('\n[campus-migration] summary');
  console.log(`  schools processed ................ ${summary.schoolsProcessed}`);
  console.log(`  campuses created ................. ${summary.campusesCreated}`);
  console.log(`  students backfilled ............. ${summary.studentsBackfilled}`);
  console.log(`  payments backfilled ............. ${summary.paymentsBackfilled}`);
  console.log(`  disbursement batches backfilled . ${summary.disbursementBatchesBackfilled}`);
  console.log(`  LMS records backfilled .......... ${summary.lmsBackfilled}`);
  console.log(`  schools multiSignatory=false .... ${summary.schoolsMultiSignatorySet}`);

  await mongoose.disconnect();
  return summary;
};

run()
  .then(() => {
    console.log('[campus-migration] done.');
    process.exit(0);
  })
  .catch(async (error) => {
    console.error('[campus-migration] failed:', error);
    await mongoose.disconnect().catch(() => {});
    process.exit(1);
  });