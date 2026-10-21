// The grade arithmetic a report card is made of.
//
// Pure unit tests, no database: `utils/gradeBands.js` and `utils/subjectResults.js`
// are the two modules that decide what a parent's child scored, and both are
// pure functions precisely so they can be pinned like this.
//
// The frontend carries a copy of the band table so the teacher's grid can
// preview a total as they type. That copy is pinned to the same cases in
// `frontend/src/utils/gradeBands.test.js`, because the one failure this
// module must never have is the two disagreeing.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  gradeForScore,
  meaningForGrade,
  calculateTotalScore,
  normaliseClassScore,
  GRADE_BANDS,
  CLASS_SCORE_MAX,
  EXAM_SCORE_MAX,
  CLASS_WEIGHT,
  EXAM_WEIGHT,
} from '../src/utils/gradeBands.js';
import { DEFAULT_CLASS_COMPONENTS } from '../src/utils/gradingConfig.js';
import {
  positionLabel,
  buildSubjectResults,
  buildSubjectResultsFromPayload,
  assignSubjectPositions,
  rankByAverage,
  averageOfTotals,
} from '../src/utils/subjectResults.js';

// ── The bands ─────────────────────────────────────────────────────────────────

describe('gradeForScore — the five-band scale', () => {
  test('bands a percentage into its letter', () => {
    assert.equal(gradeForScore(85), 'A');
    assert.equal(gradeForScore(80), 'A');
    assert.equal(gradeForScore(76), 'A-');
    assert.equal(gradeForScore(72), 'B+');
    assert.equal(gradeForScore(66), 'B');
    assert.equal(gradeForScore(64), 'F');
    assert.equal(gradeForScore(0), 'F');
  });

  test('respects the maximum a subject was marked against', () => {
    // The band is read from the proportion, so a 45-marker is a band wherever
    // it was marked out of.
    assert.equal(gradeForScore(45, 50), 'A');
    assert.equal(gradeForScore(90, 100), 'A');
    assert.equal(gradeForScore(33, 50), 'B');
  });

  test('never returns an empty band for a nonsense input', () => {
    assert.equal(gradeForScore(''), 'F');
    assert.equal(gradeForScore(null), 'F');
    assert.equal(gradeForScore(undefined), 'F');
    assert.equal(gradeForScore('nonsense'), 'F');
    assert.equal(gradeForScore(50, 0), 'F');
  });

  test('the band table is the five the terminal report prints', () => {
    assert.deepEqual(
      GRADE_BANDS.map((b) => b.grade),
      ['A', 'A-', 'B+', 'B', 'F']
    );
  });
});

describe('meaningForGrade', () => {
  test('names the band the way the report prints it', () => {
    assert.equal(meaningForGrade('A'), 'Advance');
    assert.equal(meaningForGrade('A-'), 'Proficient');
    assert.equal(meaningForGrade('B+'), 'Approaching Proficiency');
    assert.equal(meaningForGrade('B'), 'Developing');
    assert.equal(meaningForGrade('F'), 'Beginning');
  });

  test('has a dash for a letter that is not on the scale', () => {
    assert.equal(meaningForGrade('Z'), '—');
    assert.equal(meaningForGrade(''), '—');
  });
});

// ── The weighting ─────────────────────────────────────────────────────────────

describe('the 30/70 split', () => {
  test('the report’s own maxima are 30 and 100', () => {
    assert.equal(CLASS_SCORE_MAX, 30);
    assert.equal(EXAM_SCORE_MAX, 100);
  });

  test('the weights are 30/70', () => {
    assert.equal(CLASS_WEIGHT, 30);
    assert.equal(EXAM_WEIGHT, 70);
  });

  test('the default breakdown sums to the class weight', () => {
    const total = DEFAULT_CLASS_COMPONENTS.reduce((sum, part) => sum + part.weight, 0);
    assert.equal(total, CLASS_WEIGHT);
  });
});

// ── The total ─────────────────────────────────────────────────────────────────

describe('calculateTotalScore — the class/exam breakdown', () => {
  test('24/30 + 60/100 is a total of 66 and a grade of B', () => {
    // The acceptance case, and the one the whole feature exists for. The class
    // score carries 24 of its 30 points and the exam 42 of its 70, for 66.
    const result = calculateTotalScore(24, 30, 60, 100);
    assert.equal(result.totalScore, 66);
    assert.equal(result.grade, 'B');
    assert.equal(result.meaning, 'Developing');
    assert.equal(result.classPoints, 24);
    assert.equal(result.examPoints, 42);
  });

  test('is not a plain sum of the two raw marks', () => {
    // The bug this pins: adding 24 + 60 gives 84, which would put a student who
    // scored 80% in class and 60% in the exam at 84% overall.
    const result = calculateTotalScore(24, 30, 60, 100);
    assert.notEqual(result.totalScore, 84);
  });

  test('a perfect class and paper is a hundred and a blank pair is a zero', () => {
    assert.equal(calculateTotalScore(30, 30, 100, 100).totalScore, 100);
    assert.equal(calculateTotalScore(30, 30, 100, 100).grade, 'A');
    assert.equal(calculateTotalScore(0, 30, 0, 100).totalScore, 0);
    assert.equal(calculateTotalScore(0, 30, 0, 100).grade, 'F');
  });

  test('a missing half counts as zero rather than as NaN', () => {
    // 30/30 is not in, so only the exam contributes: 48/100 × 70 = 34.
    const result = calculateTotalScore('', 30, 48, 100);
    assert.equal(result.totalScore, 34);
    assert.ok(Number.isFinite(result.totalScore));
  });

  test('honours a school that runs a 40/60 split', () => {
    // 24/30 and 60/100, but the class carries 40 and the exam 60: the class
    // contributes 32 and the exam 36, for 68 — a B.
    const result = calculateTotalScore(24, 30, 60, 100, { classWeight: 40, examWeight: 60 });
    assert.equal(result.totalScore, 68);
    assert.equal(result.grade, 'B');
  });

  test('defaults to the report’s own maxima when none are passed', () => {
    const withDefaults = calculateTotalScore(24, undefined, 60, undefined);
    const withExplicit = calculateTotalScore(24, 30, 60, 100);
    assert.deepEqual(withDefaults, withExplicit);
  });
});

describe('normaliseClassScore — a direct class score rescales onto the weight', () => {
  test('a legacy /50 mark reads as the same proportion on /30', () => {
    // 45/50 and 27/30 are the same 90%, and contribute the same to the total.
    assert.equal(normaliseClassScore(45, 50, { classWeight: 30 }), 27);
    assert.equal(normaliseClassScore(27, 30, { classWeight: 30 }), 27);
  });

  test('a mark already on 30 is unchanged', () => {
    assert.equal(normaliseClassScore(24, 30, { classWeight: 30 }), 24);
    assert.equal(normaliseClassScore(0, 30, { classWeight: 30 }), 0);
  });

  test('falls back to the class weight when the maximum is absent', () => {
    assert.equal(normaliseClassScore(18, null, { classWeight: 30 }), 18);
  });

  test('follows a school that changed the split', () => {
    // A 40/60 school’s 45/50 is 90% of its 40-point class assessment → 36.
    assert.equal(normaliseClassScore(45, 50, { classWeight: 40 }), 36);
  });
});

// ── The subject table ─────────────────────────────────────────────────────────

describe('buildSubjectResults — a subject is a pair of marks', () => {
  const parts = {
    class_test: { subject: 'English', assessmentType: 'class_test', score: 80, maxScore: 100 },
    group_work: { subject: 'English', assessmentType: 'group_work', score: 80, maxScore: 100 },
    homework: { subject: 'English', assessmentType: 'homework', score: 16, maxScore: 20 },
    class_work: { subject: 'English', assessmentType: 'class_work', score: 16, maxScore: 20 },
  };
  // 7.2 + 7.2 + 4.8 + 4.8 = 24 out of 30.
  const english = [
    parts.class_test, parts.group_work, parts.homework, parts.class_work,
    { subject: 'English', assessmentType: 'exam_score', score: 60, maxScore: 100 },
  ];
  const maths = [
    { subject: 'Mathematics', assessmentType: 'class_score', score: 24, maxScore: 30 },
  ];

  test('folds a breakdown into one result with the weighted total and grade', () => {
    const results = buildSubjectResults(english);
    const row = results.find((r) => r.subject === 'English');
    assert.equal(row.classScore, 24);
    assert.equal(row.classMaxScore, 30);
    assert.equal(row.examScore, 60);
    assert.equal(row.examMaxScore, 100);
    assert.equal(row.examPoints, 42);
    assert.equal(row.totalScore, 66);
    assert.equal(row.grade, 'B');
    assert.equal(row.complete, true);
    assert.equal(row.classParts.length, 4);
    assert.equal(row.subjectPosition, undefined);
  });

  test('a lone class score (no parts) is the class score, normalised to 30', () => {
    const results = buildSubjectResults([
      { subject: 'Mathematics', assessmentType: 'class_score', score: 24, maxScore: 30 },
      { subject: 'Mathematics', assessmentType: 'exam_score', score: 60, maxScore: 100 },
    ]);
    const row = results.find((r) => r.subject === 'Mathematics');
    assert.equal(row.classScore, 24);
    assert.equal(row.classMaxScore, 30);
    assert.equal(row.totalScore, 66);
  });

  test('a legacy /50 class score rescales onto /30 without a migration', () => {
    // The migration only renamed the row; the proportion is what is preserved.
    const results = buildSubjectResults([
      { subject: 'Mathematics', assessmentType: 'class_score', score: 45, maxScore: 50 },
      { subject: 'Mathematics', assessmentType: 'exam_score', score: 78, maxScore: 100 },
    ]);
    const row = results.find((r) => r.subject === 'Mathematics');
    assert.equal(row.classScore, 27); // 45/50 → 27/30
    assert.equal(row.classMaxScore, 30);
    // 27 + round(78/100 × 70) = 27 + 55 = 82.
    assert.equal(row.examScore, 78);
    assert.equal(row.examMaxScore, 100);
    assert.equal(row.totalScore, 82);
    assert.equal(row.grade, 'A');
  });

  test('a subject with one half is incomplete, not a zero', () => {
    const results = buildSubjectResults(maths);
    const row = results.find((r) => r.subject === 'Mathematics');
    assert.equal(row.classScore, 24);
    assert.equal(row.examScore, null);
    assert.equal(row.totalScore, null);
    assert.equal(row.grade, '');
    assert.equal(row.complete, false);
  });

  test('an incomplete breakdown has no class score', () => {
    // Missing class_work → the class assessment is not in, so no class score and
    // no total even though the other three parts are.
    const results = buildSubjectResults([
      parts.class_test, parts.group_work, parts.homework,
      { subject: 'English', assessmentType: 'exam_score', score: 60, maxScore: 100 },
    ]);
    const row = results.find((r) => r.subject === 'English');
    assert.equal(row.classScore, null);
    assert.equal(row.complete, false);
    assert.equal(row.totalScore, null);
  });

  test('the results come back in subject order', () => {
    const results = buildSubjectResults([...maths, ...english]);
    assert.deepEqual(results.map((r) => r.subject), ['English', 'Mathematics']);
  });

  test('a part marked out of its own maximum contributes the right proportion', () => {
    // class_test 45/50 is the same 90% as 90/100, so with identical other parts
    // the class score (and therefore the total) is the same.
    const sameProportion = buildSubjectResults([
      { subject: 'English', assessmentType: 'class_test', score: 45, maxScore: 50 },
      { subject: 'English', assessmentType: 'group_work', score: 80, maxScore: 100 },
      { subject: 'English', assessmentType: 'homework', score: 16, maxScore: 20 },
      { subject: 'English', assessmentType: 'class_work', score: 16, maxScore: 20 },
      { subject: 'English', assessmentType: 'exam_score', score: 60, maxScore: 100 },
    ]);
    const diffMax = buildSubjectResults([
      { subject: 'English', assessmentType: 'class_test', score: 90, maxScore: 100 },
      { subject: 'English', assessmentType: 'group_work', score: 80, maxScore: 100 },
      { subject: 'English', assessmentType: 'homework', score: 16, maxScore: 20 },
      { subject: 'English', assessmentType: 'class_work', score: 16, maxScore: 20 },
      { subject: 'English', assessmentType: 'exam_score', score: 60, maxScore: 100 },
    ]);
    assert.equal(sameProportion[0].totalScore, diffMax[0].totalScore);
  });
});

describe('buildSubjectResultsFromPayload — the teacher’s own compile path', () => {
  test('folds a class/exam pair exactly as the grade book does', () => {
    const results = buildSubjectResultsFromPayload([
      { subject: 'English', classScore: 24, examScore: 60 },
    ]);
    assert.equal(results[0].classScore, 24);
    assert.equal(results[0].examScore, 60);
    assert.equal(results[0].totalScore, 66);
    assert.equal(results[0].grade, 'B');
  });

  test('takes the pre-split single figure as the total it already is', () => {
    const results = buildSubjectResultsFromPayload([
      { subject: 'English', score: 72, maxScore: 100 },
    ]);
    assert.equal(results[0].totalScore, 72);
    assert.equal(results[0].grade, 'B+');
    assert.equal(results[0].classScore, null);
  });

  test('a half-entered subject is incomplete, as everywhere else', () => {
    const results = buildSubjectResultsFromPayload([
      { subject: 'English', classScore: 24 },
    ]);
    assert.equal(results[0].complete, false);
    assert.equal(results[0].totalScore, null);
  });
});

// ── The positions ─────────────────────────────────────────────────────────────

describe('positionLabel', () => {
  test('writes the ordinal the report prints', () => {
    assert.equal(positionLabel(1), '1st');
    assert.equal(positionLabel(2), '2nd');
    assert.equal(positionLabel(3), '3rd');
    assert.equal(positionLabel(4), '4th');
    assert.equal(positionLabel(11), '11th');
    assert.equal(positionLabel(12), '12th');
    assert.equal(positionLabel(13), '13th');
    assert.equal(positionLabel(21), '21st');
    assert.equal(positionLabel(22), '22nd');
    assert.equal(positionLabel(23), '23rd');
  });

  test('is a dash for a rank that is not there', () => {
    assert.equal(positionLabel(0), '—');
    assert.equal(positionLabel(null), '—');
    assert.equal(positionLabel(undefined), '—');
  });
});

describe('assignSubjectPositions — ranking within a subject', () => {
  const resultsFor = (totals) => {
    const map = new Map();
    totals.forEach(([studentId, total]) => {
      map.set(studentId, [
        { subject: 'English', totalScore: total, complete: true },
      ]);
    });
    return map;
  };

  test('ranks the class within the subject', () => {
    const positions = assignSubjectPositions(
      resultsFor([
        ['s1', 90],
        ['s2', 70],
        ['s3', 50],
      ])
    );
    assert.equal(positions.get('s1').get('English'), '1st');
    assert.equal(positions.get('s2').get('English'), '2nd');
    assert.equal(positions.get('s3').get('English'), '3rd');
  });

  test('ties share the lower position and the next is skipped', () => {
    // Competition ranking ("1224"): two joint first are both 1st and the next
    // is 3rd. Giving them "1" and "2" tells the second one they beat someone
    // they did not.
    const positions = assignSubjectPositions(
      resultsFor([
        ['s1', 90],
        ['s2', 90],
        ['s3', 70],
      ])
    );
    assert.equal(positions.get('s1').get('English'), '1st');
    assert.equal(positions.get('s2').get('English'), '1st');
    assert.equal(positions.get('s3').get('English'), '3rd');
  });

  test('an incomplete subject is not ranked at all', () => {
    const map = new Map([
      ['s1', [{ subject: 'English', totalScore: 90, complete: true }]],
      ['s2', [{ subject: 'English', totalScore: null, complete: false }]],
    ]);
    const positions = assignSubjectPositions(map);
    assert.equal(positions.get('s1').get('English'), '1st');
    assert.equal(positions.has('s2'), false);
  });
});

describe('rankByAverage — the class position', () => {
  const draft = (id, average, completedCount = 1) => ({
    student: { _id: id },
    average,
    completedCount,
  });

  test('ranks by the average of the subject totals', () => {
    const positions = rankByAverage([
      draft('s1', 80),
      draft('s2', 60),
      draft('s3', 70),
    ]);
    assert.equal(positions.get('s1'), 1);
    assert.equal(positions.get('s3'), 2);
    assert.equal(positions.get('s2'), 3);
  });

  test('a student with nothing marked is not ranked at all', () => {
    const positions = rankByAverage([
      draft('s1', 80),
      draft('s2', 0, 0),
    ]);
    assert.equal(positions.get('s1'), 1);
    assert.equal(positions.has('s2'), false);
  });

  test('a student who genuinely scored zero is ranked — last', () => {
    const positions = rankByAverage([
      draft('s1', 80),
      draft('s2', 0, 3),
    ]);
    assert.equal(positions.get('s2'), 2);
  });
});

describe('averageOfTotals', () => {
  test('averages the completed subjects only', () => {
    const results = [
      { subject: 'English', totalScore: 80, complete: true },
      { subject: 'Mathematics', totalScore: 60, complete: true },
      { subject: 'Science', totalScore: null, complete: false },
    ];
    assert.equal(averageOfTotals(results), 70);
  });

  test('is zero when nothing is complete', () => {
    assert.equal(averageOfTotals([]), 0);
    assert.equal(
      averageOfTotals([{ subject: 'English', totalScore: null, complete: false }]),
      0
    );
  });
});
