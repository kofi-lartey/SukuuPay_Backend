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
  GRADE_BANDS,
  CLASS_SCORE_MAX,
  EXAM_SCORE_MAX,
} from '../src/utils/gradeBands.js';
import {
  positionLabel,
  buildSubjectResults,
  buildSubjectResultsFromPayload,
  assignSubjectPositions,
  rankByAverage,
  averageOfTotals,
} from '../src/utils/subjectResults.js';

// ── The bands ───────────────────────────────────────────────────────────────

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

// ── The total ───────────────────────────────────────────────────────────────

describe('calculateTotalScore — the class/exam breakdown', () => {
  test('42 out of 50 and 48 out of 100 is a total of 66 and a grade of B', () => {
    // The acceptance case, and the one the whole feature exists for.
    const result = calculateTotalScore(42, 50, 48, 100);
    assert.equal(result.totalScore, 66);
    assert.equal(result.grade, 'B');
    assert.equal(result.meaning, 'Developing');
  });

  test('is not a plain sum of the two raw marks', () => {
    // The bug this pins: 42 + 48 = 90 would put a student who scored 84% in
    // class and 48% in the exam at 90% overall.
    const result = calculateTotalScore(42, 50, 48, 100);
    assert.notEqual(result.totalScore, 90);
  });

  test('a perfect paper is a hundred and a blank paper is a zero', () => {
    assert.equal(calculateTotalScore(50, 50, 100, 100).totalScore, 100);
    assert.equal(calculateTotalScore(50, 50, 100, 100).grade, 'A');
    assert.equal(calculateTotalScore(0, 50, 0, 100).totalScore, 0);
    assert.equal(calculateTotalScore(0, 50, 0, 100).grade, 'F');
  });

  test('a missing half counts as zero rather than as NaN', () => {
    const result = calculateTotalScore('', 50, 48, 100);
    assert.equal(result.totalScore, 24);
    assert.ok(Number.isFinite(result.totalScore));
  });

  test('the report’s own maxima are 50 and 100', () => {
    assert.equal(CLASS_SCORE_MAX, 50);
    assert.equal(EXAM_SCORE_MAX, 100);
  });
});

// ── The subject table ───────────────────────────────────────────────────────

describe('buildSubjectResults — a subject is a pair of marks', () => {
  const rows = [
    { subject: 'English', assessmentType: 'class_score', score: 42, maxScore: 50 },
    { subject: 'English', assessmentType: 'exam_score', score: 48, maxScore: 100 },
    { subject: 'Mathematics', assessmentType: 'class_score', score: 30, maxScore: 50 },
  ];

  test('folds a pair into one result with a total and a grade', () => {
    const results = buildSubjectResults(rows);
    const english = results.find((r) => r.subject === 'English');
    assert.equal(english.classScore, 42);
    assert.equal(english.examScore, 48);
    assert.equal(english.totalScore, 66);
    assert.equal(english.grade, 'B');
    assert.equal(english.complete, true);
  });

  test('a subject with one half is incomplete, not a zero', () => {
    // The bug this pins: a teacher who has entered the class scores but not
    // the exam scores would otherwise produce report cards reading
    // "Total 30, Grade A" for every child in the class.
    const results = buildSubjectResults(rows);
    const maths = results.find((r) => r.subject === 'Mathematics');
    assert.equal(maths.classScore, 30);
    assert.equal(maths.examScore, null);
    assert.equal(maths.totalScore, null);
    assert.equal(maths.grade, '');
    assert.equal(maths.complete, false);
  });

  test('the results come back in subject order', () => {
    const results = buildSubjectResults(rows);
    assert.deepEqual(results.map((r) => r.subject), ['English', 'Mathematics']);
  });

  test('a school that marks its continuous assessment out of 60 still totals', () => {
    const results = buildSubjectResults([
      { subject: 'Science', assessmentType: 'class_score', score: 45, maxScore: 60 },
      { subject: 'Science', assessmentType: 'exam_score', score: 48, maxScore: 100 },
    ]);
    assert.equal(results[0].totalScore, 62);
  });
});

describe('buildSubjectResultsFromPayload — the teacher’s own compile path', () => {
  test('folds a class/exam pair exactly as the grade book does', () => {
    const results = buildSubjectResultsFromPayload([
      { subject: 'English', classScore: 42, examScore: 48 },
    ]);
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
      { subject: 'English', classScore: 42 },
    ]);
    assert.equal(results[0].complete, false);
    assert.equal(results[0].totalScore, null);
  });
});

// ── The positions ───────────────────────────────────────────────────────────

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
    // An unranked student sitting in the middle of the table reads as a fail
    // rather than as "not marked yet".
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
