// ─────────────────────────────────────────────
// Backfill `User.assignedClasses` from live class-mediated TeacherAssignments
// ─────────────────────────────────────────────
//
//   node scripts/repair-teacher-assigned-classes.js
//
// Existing class-mediated assignments were written to `TeacherAssignment`
// rows but never to `User.assignedClasses`, so the teacher portal
// (`GET /teacher/classes`, timetables, grades, attendance, schedule) showed
// nothing for those teachers.
//
// This script is idempotent and additive: for every teacher it computes the
// set of classes they hold live class-mediated assignments for, intersects
// with the school's current `academic.classes` (so retired names are never
// re-added), and appends any missing `{ className, subject: '' }` entries.
// It never removes entries the admin set by hand.
//
// Usage:
//   MONGODB_URI=... node scripts/repair-teacher-assigned-classes.js
//
import mongoose from 'mongoose';
import { User } from '../src/models/userModel.js';
import { School } from '../src/models/schoolModel.js';
import { TeacherAssignment } from '../src/models/TeacherAssignment.js';
import { MONGODB_URI } from '../src/config/env.js';

if (!MONGODB_URI) {
  console.error('MONGODB_URI is not set. Nothing to do.');
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(MONGODB_URI);
  console.log('Connected.\n');

  // Every live class-mediated assignment, projected to the fields we need.
  const rows = await TeacherAssignment.find({
    classMediated: true,
    removedAt: null,
  })
    .select('schoolId teacherId className')
    .lean();

  // Group class names per (school, teacher).
  const byTeacher = new Map(); // teacherId -> { schoolId, Set<className> }
  for (const row of rows) {
    const className = String(row.className || '').trim();
    if (!className) continue;
    let entry = byTeacher.get(String(row.teacherId));
    if (!entry) {
      entry = { schoolId: row.schoolId, classes: new Set() };
      byTeacher.set(String(row.teacherId), entry);
    }
    entry.classes.add(className);
  }

  if (byTeacher.size === 0) {
    console.log('No live class-mediated assignments found. Nothing to update.');
    await mongoose.disconnect();
    return;
  }

  console.log(`── Found ${byTeacher.size} teacher(s) with class-mediated assignments ──\n`);

  let touched = 0;
  let addedTotal = 0;

  for (const [teacherId, { schoolId, classes }] of byTeacher) {
    const school = await School.findById(schoolId)
      .select('academic.classes deletedAt name')
      .lean();
    if (!school || school.deletedAt) {
      console.log(`  SKIP  teacher=${teacherId}  school=${schoolId} (missing or deleted)`);
      continue;
    }

    const schoolClasses = new Set(
      Array.isArray(school.academic?.classes)
        ? school.academic.classes.map(String)
        : []
    );

    const current = await User.findById(teacherId)
      .select('name email role assignedClasses schoolId')
      .lean();
    if (!current || current.deletedAt) {
      console.log(`  SKIP  teacher=${teacherId} (account missing)`);
      continue;
    }

    const existing = new Set(
      Array.isArray(current.assignedClasses)
        ? current.assignedClasses.map((e) => String(e.className || '')).filter(Boolean)
        : []
    );

    const toAdd = [...classes]
      .filter((c) => schoolClasses.has(c)) // only classes the school still runs
      .filter((c) => !existing.has(c)); // never duplicate what's already there

    if (toAdd.length === 0) {
      console.log(`  OK    ${current.email || teacherId}  (already assigned)`);
      continue;
    }

    const update = toAdd.map((c) => ({ className: c, subject: '' }));
    await User.updateOne(
      { _id: teacherId },
      { $addToSet: { assignedClasses: { $each: update } } }
    );
    touched++;
    addedTotal += toAdd.length;
    console.log(
      `  FIX   ${current.email || teacherId}  role=${current.role}  +${toAdd.length} class(es): ${toAdd.join(', ')}`
    );
  }

  console.log(`\n── Summary ──`);
  console.log(`Teachers touched: ${touched}`);
  console.log(`Classes added:    ${addedTotal}`);
  console.log(`Total teachers:   ${byTeacher.size}`);

  await mongoose.disconnect();
};

run().catch(async (error) => {
  console.error('Migration failed:', error.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
