/**
 * The one definition of an attendance rate.
 *
 * Every surface that quotes attendance — the parent portal, the teacher's class
 * summary, the teacher's per-student view, the report-card tally, the headmaster's
 * dashboard, the admin register report — has to quote the *same* number for the
 * same register. A parent who is told 80% by the portal and 100% by the teacher
 * at the gate concludes that the portal is broken, and a portal that is right
 * about the marks and wrong about the arithmetic is exactly as useless as one
 * that is wrong about the marks.
 *
 * ## The rule
 *
 *   rate = (present + late) / (present + late + absent)
 *
 * Three decisions are baked into that, and each of them was once made
 * differently in two places:
 *
 *  - **`late` counts as attended.** The student was in the school; the register
 *    records that they arrived after the bell. The teacher class summary, the
 *    report-card tally and the headmaster's dashboard have all counted a late
 *    mark as attendance since they were written. The parent portal did not, and
 *    so a family with one late morning in a term saw the portal quote a lower
 *    rate than the teacher did for the same marks.
 *
 *  - **`excused` and `holiday` are outside the denominator.** An excused absence
 *    is a day the school agreed the student need not attend, and a `holiday` mark
 *    is a day there was no register. Scoring either against a family is how a
 *    portal stops being trusted. They are counted and reported, but they do not
 *    make the term's rate smaller.
 *
 *  - **Only days that were actually marked are counted at all.** A term of sixty
 *    school days is not a hundred-and-twenty-day term once the weekends are in
 *    it, and the denominator is the number of days a register was taken.
 *
 * ## Why one function
 *
 * The definition was previously re-derived in five places, and the copies had
 * already drifted. `classes.service.js` even carried a comment saying the class
 * rate was "borrowed whole from the parent portal" — while computing something
 * different from it. A rate is a rule; a rule with five copies is five rules
 * waiting for the next change.
 */

/**
 * The tally of a set of `Attendance` records.
 *
 * Takes the records rather than the counts so a caller cannot half-fill the
 * summary: the counts are derived here, in one place, from the statuses
 * themselves.
 *
 * @param {Array<{status?: string}>} records
 * @returns {{present: number, late: number, absent: number, excused: number,
 *            holiday: number, attended: number, totalDays: number, rate: number}}
 */
export const summariseAttendance = (records = []) => {
  let present = 0;
  let late = 0;
  let absent = 0;
  let excused = 0;
  let holiday = 0;

  for (const record of records) {
    switch (record?.status) {
      case "present":
        present += 1;
        break;
      case "late":
        late += 1;
        break;
      case "absent":
        absent += 1;
        break;
      case "excused":
        excused += 1;
        break;
      case "holiday":
        holiday += 1;
        break;
      default:
        // A status this build does not know about is not counted anywhere.
        // Skipping it keeps the denominator honest rather than inventing a
        // bucket for a mark this code does not understand.
        break;
    }
  }

  // The days the register was taken: the ones the rate is a fraction of.
  const totalDays = present + late + absent;
  const attended = present + late;

  return {
    present,
    late,
    absent,
    excused,
    holiday,
    attended,
    totalDays,
    // One decimal place, to match the shape every other surface prints.
    rate: totalDays > 0 ? Math.round((attended / totalDays) * 1000) / 10 : 0,
  };
};

export default { summariseAttendance };
