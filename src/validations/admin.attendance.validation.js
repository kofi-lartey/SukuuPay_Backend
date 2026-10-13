import Joi from "joi";

const STATUSES = ["present", "late", "absent", "excused", "holiday"];

/**
 * The register, written one class at a time.
 *
 * `date` is an ISO date and is normalised to 00:00 UTC by the service: the
 * register is a *day*, not an instant, and a submission carrying `10:30` on the
 * 6th must land on the same row as one carrying `07:00` on the 6th.
 *
 * `studentId` is constrained to 24 hex characters so the ObjectId cast inside
 * `Attendance.bulkWrite` cannot throw. Without it a malformed id is a CastError
 * the controller answers with a 500 — "why did my whole class fail to save" for
 * a typo in one field.
 *
 * `arrivalTime` is only meaningful for a late mark and is left optional for
 * everything else; the service stores `null` when it is absent.
 */
export const bulkMarkAttendanceSchema = Joi.object({
  date: Joi.date().iso().required(),
  className: Joi.string().trim().min(2).max(50).required(),
  marks: Joi.array()
    .items(
      Joi.object({
        studentId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
        status: Joi.string()
          .valid(...STATUSES)
          .required(),
        note: Joi.string().trim().max(300).allow("").optional(),
        arrivalTime: Joi.date().iso().optional().allow(null),
      })
    )
    .min(1)
    .max(200)
    .required(),
});

/**
 * A geofenced check-in.
 *
 * Both locations are required and both are `{ lat, lng }`, because the check is
 * a distance between two points and the server will not supply either of them —
 * taking the school's coordinates from a default would let a caller claim to be
 * anywhere they liked by sending a school that is where they are standing.
 *
 * `maxMeters` is bounded at 50–2000. The floor is tighter than a compound and
 * the ceiling is the whole campus; a caller asking for 50km is asking for the
 * check to pass everywhere, which is the same as not running it.
 */
export const autoMarkPresentSchema = Joi.object({
  studentId: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required(),
  className: Joi.string().trim().min(2).max(50).required(),
  location: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
  }).required(),
  schoolLocation: Joi.object({
    lat: Joi.number().min(-90).max(90).required(),
    lng: Joi.number().min(-180).max(180).required(),
  }).required(),
  maxMeters: Joi.number().integer().min(50).max(2000).default(200),
});
