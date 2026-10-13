import { Attendance } from "../../models/Attendance.js";
import { Student } from "../../models/studentModel.js";
import { log as auditLog } from "../../utils/auditService.js";
import { isWithinRadius } from "../../utils/geoDistance.js";
import { isoDay } from "../../utils/termDates.js";
import { AUDIT_ACTIONS } from "../../config/constants.js";
import ApiError from "../../utils/ApiError.js";

/** 00:00 UTC of the given day, or of today when none is given. */
const startOfDay = (value) => {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) {
    throw new ApiError(400, "That date could not be read", "INVALID_DATE");
  }
  date.setUTCHours(0, 0, 0, 0);
  return date;
};

/**
 * Replace one class's register for one day, in a single call.
 *
 * The endpoint is an upsert by design. A teacher takes a roll on paper or on a
 * phone, comes back to a laptop, and types the whole class in — so the batch is
 * the unit of work, and submitting it twice must not double the register. The
 * unique index on `{ schoolId, studentId, date }` is what makes the second
 * submission an update rather than a duplicate row, and it is why the filter
 * below names those three fields and nothing else.
 *
 * **One `bulkWrite`, not one write per student.** `{ ordered: false }` means the
 * operations run concurrently and a single bad row does not abandon the rest, so
 * a teacher submitting a class of forty gets forty rows rather than the eleven
 * that happened to precede the failure. Nothing else in this file is batched, and
 * nothing here is transactional: a partial write leaves the *unenumerated*
 * marks untouched, and re-submitting the same batch corrects any that were
 * skipped.
 *
 * **Every student is checked against the school before anything is written.**
 * A payload mixing students from two schools would otherwise let one bursar
 * write attendance onto another school's roster by guessing ObjectIds.
 */
export const bulkMarkAttendance = async (schoolId, userId, payload) => {
  const { date, className, marks } = payload;
  if (!date || !className || !Array.isArray(marks) || marks.length === 0) {
    throw new ApiError(400, "date, className, and marks are required", "VALIDATION_ERROR");
  }

  const studentIds = marks.map((m) => m.studentId);
  const students = await Student.find({
    _id: { $in: studentIds },
    schoolId,
    deletedAt: null,
  })
    .select("_id")
    .lean();

  const owned = new Set(students.map((s) => s._id.toString()));
  const unknown = marks.filter((m) => !owned.has(String(m.studentId)));
  if (unknown.length > 0) {
    throw new ApiError(
      400,
      `${unknown.length} student${unknown.length === 1 ? "" : "s"} do not belong to this school`,
      "INVALID_STUDENTS"
    );
  }

  const attendanceDate = startOfDay(date);

  const operations = marks.map((mark) => ({
    updateOne: {
      filter: { schoolId, studentId: mark.studentId, date: attendanceDate },
      update: {
        $set: {
          schoolId,
          studentId: mark.studentId,
          className,
          date: attendanceDate,
          status: mark.status,
          note: mark.note || "",
          arrivalTime: mark.arrivalTime ? new Date(mark.arrivalTime) : null,
          markedBy: userId,
          markedAt: new Date(),
          // A teacher typing the register is the source of truth; these two are
          // cleared so a row that was auto-marked this morning reads as
          // teacher-confirmed once it is submitted, not as an unexplained mix of
          // the two.
          autoMarked: false,
          locationVerified: false,
        },
      },
      upsert: true,
    },
  }));

  const result = await Attendance.bulkWrite(operations, { ordered: false });

  await auditLog({
    action: AUDIT_ACTIONS.ATTENDANCE_BULK_MARK,
    entity: "Attendance",
    userId,
    schoolId,
    meta: {
      className,
      date: isoDay(attendanceDate),
      count: marks.length,
      upserted: result.upsertedCount,
      modified: result.modifiedCount,
    },
  });

  return {
    className,
    date: isoDay(attendanceDate),
    saved: marks.length,
    created: result.upsertedCount,
    updated: result.modifiedCount,
  };
};

/**
 * Mark a student present from a geofenced check-in.
 *
 * The handset sends its own coordinates and the school's, and the server decides
 * — a client that simply asserted "I am at school" would make the whole feature
 * a formality. `OUT_OF_RANGE` is the answer when the distance exceeds the limit,
 * and it is a 400 rather than a 403 because nothing about the caller is
 * unauthorised: they are simply standing somewhere else.
 *
 * `$setOnInsert` rather than `$set`: an auto-mark never overwrites a row that
 * already exists. A teacher's register wins over a geofence every time, because
 * a phone can be in the compound while its owner is still at home.
 *
 * Deliberately **not** filtered on `deletedAt`. A soft-deleted row is reused by
 * this upsert rather than colliding with the unique index, which would otherwise
 * surface as a duplicate-key 500 on the one route a parent's child uses to check
 * in.
 */
export const autoMarkPresent = async (schoolId, userId, payload) => {
  const { studentId, className, location, schoolLocation, maxMeters = 200 } = payload;

  if (!studentId || !className || !location || !schoolLocation) {
    throw new ApiError(
      400,
      "studentId, className, location, and schoolLocation are required",
      "VALIDATION_ERROR"
    );
  }

  const within = isWithinRadius(location, schoolLocation, maxMeters);
  if (!within) {
    throw new ApiError(400, "You are not within the school area", "OUT_OF_RANGE");
  }

  const today = startOfDay();

  const result = await Attendance.findOneAndUpdate(
    { schoolId, studentId, date: today },
    {
      $setOnInsert: {
        schoolId,
        studentId,
        className,
        date: today,
        status: "present",
        arrivalTime: new Date(),
        markedBy: userId,
        markedAt: new Date(),
        autoMarked: true,
        locationVerified: true,
      },
    },
    { upsert: true, new: true }
  );

  await auditLog({
    action: AUDIT_ACTIONS.ATTENDANCE_AUTO_MARK,
    entity: "Attendance",
    entityId: result._id,
    userId,
    schoolId,
    meta: { date: isoDay(today), maxMeters: Number(maxMeters) || 200 },
  });

  return result.toObject();
};
