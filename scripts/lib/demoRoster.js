// ─────────────────────────────────────────────
// Realistic Ghanaian demo roster — cohort fixture
// ─────────────────────────────────────────────
// WHY THIS EXISTS
//
// `getCohorts` matches on `{ status: 'graduated', isAlumni: true }`. The seed in
// `seed.js` created exactly one *active* student, so on a fresh database the
// Cohorts tab showed "No cohorts yet" — which is correct behaviour reading as a
// broken feature. There is no way to exercise a cohort without students who
// actually graduated.
//
// This module builds those students. It is deliberately deterministic: a seeded
// PRNG, not `Math.random()`, so two runs on two machines produce byte-identical
// data and a reviewer comparing a screenshot against a fresh seed is comparing
// like with like.
//
// WHAT IT BUYS
//
//   - Four graduating cohorts (2023–2026) so the cohort list, the cohort detail
//     and the alumni filters all have something to page through.
//   - A current 2026/2027 roster across Nursery, Primary and JHS, with the full
//     spread of fee states — cleared, part-paid, owing, overdue — so the roster's
//     KPI band, its fee-status badges and its filters are all exercised rather
//     than showing a uniform column of zeroes.
//   - Installment plans with realistic monthly schedules, some partly paid.
//   - Settled payments, so the profile drawer's payment history is populated.
//
// THE MONEY UNIT
//
// Every amount here is in **pesewas**, like the model. `gh(850)` is GH₵ 850.00.
// Writing bare numbers is how a seed ends up billing a school GH₵ 0.85 a term,
// which reads as "the data is broken" rather than "the seed is wrong".

/** Cedi → pesewas. The only sanctioned way to write a figure in this file. */
export const gh = (cedis) => Math.round(cedis * 100);

/**
 * mulberry32 — a small, fast, seedable PRNG.
 *
 * `Math.random()` would give a different roster on every run, so a tester could
 * not tell whether a bug they found was theirs or the data's. Everything below
 * draws from one of these, so the fixture is reproducible.
 */
const rng = (seed) => () => {
  let t = (seed += 0x6d2b79f5);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const pick = (rand, list) => list[Math.floor(rand() * list.length)];
const between = (rand, min, max) => min + Math.floor(rand() * (max - min + 1));

// ── Names ──
// Akan, Ewe, Ga and Northern Ghana are all represented: a single ethnic mix
// would read as a template, and Ghanaian school rolls genuinely are not that
// uniform. Names are common, recognisably Ghanaian, and fictional.
const GIVEN_M = [
  'Kwame', 'Kofi', 'Yaw', 'Kwaku', 'Kwabena', 'Kudjoe', 'Nii', 'Elikem',
  'Mawuli', 'Selorm', 'Kofi', 'Yaw', 'Kwesi', 'Obiri', 'Nii Okai', 'Sakari',
  'Ibrahim', 'Abdul-Rahman', 'Fuseini', 'Alhassan', 'Mahama', 'Abdul Karim',
  'Nii Kwartei', 'Nii Tettey', 'Ebo', 'Kweku', 'Yaw', 'Nana Kwame', 'Kojo',
];
const GIVEN_F = [
  'Ama', 'Akosua', 'Akofa', 'Adwoa', 'Yaa', 'Abena', 'Adoma', 'Afua', 'Ama Serwaa',
  'Elikem', 'Dzifa', 'Senam', 'Efua', 'Naa Dedei', 'Naa Adjeley', 'Naa Shiki',
  'Hawa', 'Fatima', 'Zulaiha', 'Mariama', 'Adiza', 'Bilikiss', 'Gifty',
  'Naa Shairi', 'Naa Momo', 'Serwaa', 'Esi', 'Araba',
];
const FAMILY = [
  'Mensah', 'Owusu', 'Boateng', 'Asante', 'Agyei', 'Adjei', 'Appiah', 'Sarpong',
  'Amoah', 'Tetteh', 'Quartey', 'Lartey', 'Darko', 'Ansah', 'Aidoo', 'Osei',
  'Antwi', 'Frimpong', 'Gyasi', 'Nortey', 'Armah', 'Adjaye', 'Baidoo', 'Essien',
  'Amponsah', 'Aggrey', 'Danso', 'Dogbey', 'Dzomeku', 'Koomson', 'Lartey',
  'Mansoe', 'Nubaku', 'Opuni', 'Paa', 'Quaye', 'Tetteh', 'Yeboah', 'Acheampong',
];

// ── The school's class list ──
// Nursery through JHS 3, which is the shape most Ghanaian basic-and-JHS schools
// run. This ordering matters: it is what makes the `slice(-3)` final-year
// fallback wrong, and why `academic.finalYearClasses` exists.
export const CLASSES = [
  'Nursery 1', 'Nursery 2',
  'Primary 1', 'Primary 2', 'Primary 3', 'Primary 4', 'Primary 5', 'Primary 6',
  'JHS 1', 'JHS 2', 'JHS 3',
];

/** Termly fee per class, in cedis. Rises with the class, as it does in practice. */
const FEE_BY_CLASS = {
  'Nursery 1': 320, 'Nursery 2': 340,
  'Primary 1': 420, 'Primary 2': 440, 'Primary 3': 460,
  'Primary 4': 480, 'Primary 5': 510, 'Primary 6': 540,
  'JHS 1': 680, 'JHS 2': 760, 'JHS 3': 850,
};

export const FINAL_YEAR_CLASSES = ['JHS 3'];

/** Phone numbers, in the `0xx` form the model stores. */
const phone = (rand) => `0${pick(rand, ['24', '25', '27', '20', '23'])}${between(rand, 1000000, 9999999)}`;

const email = (name, i) =>
  `${name.toLowerCase().replace(/[^a-z]+/g, '.')}.${i}@example.com`;

// ── Dates ──
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
const daysAhead = (n) => new Date(Date.now() + n * 86400000);
const YEARS_BEFORE = (n) => new Date().getFullYear() - n;

/**
 * A graduation date inside the Ghanaian school year.
 *
 * Ghanaian academic years run roughly September to July, and graduations happen
 * in the last week of July. A graduation dated "now" would be wrong in a way a
 * Ghanaian tester notices immediately, so each cohort is placed on a plausible
 * date for its year rather than on today's date shifted.
 */
const graduationDateFor = (year, rand) =>
  new Date(Date(year, 6, between(rand, 20, 31), 9, 0, 0)); // late July

// ─────────────────────────────────────────────
// Student factories
// ─────────────────────────────────────────────

const guardiansFor = (rand, surname, index) => {
  const motherFirst = pick(rand, GIVEN_F);
  const fatherFirst = pick(rand, GIVEN_M);
  const guardians = [
    {
      parentName: `${motherFirst} ${surname}`,
      relationship: 'mother',
      phone: phone(rand),
      email: email(motherFirst, index),
      isPrimary: true,
      isAlive: true,
    },
  ];
  // A second guardian on about half, so the parent's own management surface has
  // something to address and the "exactly one primary" rule is visible.
  if (rand() > 0.5) {
    guardians.push({
      parentName: `${fatherFirst} ${surname}`,
      relationship: 'father',
      phone: phone(rand),
      isPrimary: false,
      isAlive: true,
    });
  }
  return guardians;
};

const emergencyFor = (rand) =>
  [
    {
      contactName: `${pick(rand, [...GIVEN_M, ...GIVEN_F])} ${pick(rand, FAMILY)}`,
      relationship: pick(rand, ['uncle', 'aunt', 'grandmother', 'grandfather', 'guardian']),
      phone: phone(rand),
      alternatePhone: rand() > 0.7 ? phone(rand) : null,
    },
  ];

/**
 * Class history: a plausible path into the current class.
 *
 * The history is a chain of real moves, not one entry, so the profile's History
 * tab and any "when did this child change class" question have an answer.
 *
 * `by` is deliberately absent. `classHistorySchema.by` is **required**, and
 * `insertMany` drops a document that fails schema validation *without throwing*
 * — so a fixture that set `by: null` wrote 61 of 278 students, silently. The
 * actor is stamped by `seed.js`, which is the only place that knows the id of the
 * admin the history is attributed to.
 */
const historyFor = (rand, className, yearsBack) => {
  const history = [];
  let from = CLASSES[Math.max(0, CLASSES.indexOf(className) - between(rand, 1, 3))];
  for (let year = yearsBack; year >= 1; year -= 1) {
    history.push({
      from,
      to: className,
      date: new Date(YEARS_BEFORE(year), 8, 12),
      reason: 'End of year promotion',
    });
    from = className;
  }
  return history;
};

/**
 * One graduating cohort.
 *
 * `outcome` decides the mix, and the mix is the point: a cohort of identical
 * `graduated` rows makes the cohort detail's four counters all read
 * graduated=N, transferred=0, dropped=0, repeating=0, which tests nothing.
 */
export const buildCohort = ({
  schoolCode,
  year,
  count,
  seed,
  className = 'JHS 3',
  honorsWeights = { NONE: 0.78, HONORS: 0.13, HIGH_HONORS: 0.06, HIGHEST_HONORS: 0.03 },
}) => {
  const rand = rng(seed);
  const students = [];
  const startSeq = 8001;

  for (let i = 0; i < count; i += 1) {
    const male = rand() > 0.48;
    const given = male ? pick(rand, GIVEN_M) : pick(rand, GIVEN_F);
    const surname = pick(rand, FAMILY);
    const name = `${given} ${surname}`;

    // Weighted honors draw, so the alumni filter has a realistic distribution
    // rather than a uniform one.
    const roll = rand();
    let cumulative = 0;
    let honors = 'NONE';
    for (const [key, weight] of Object.entries(honorsWeights)) {
      cumulative += weight;
      if (roll <= cumulative) {
        honors = key;
        break;
      }
    }

    // 8% left during or after JHS, 4% withdrew. Those are the rows that make
    // `transferredCount` and `droppedCount` non-zero.
    const roll2 = rand();
    const outcome = roll2 < 0.88 ? 'graduated' : roll2 < 0.96 ? 'transferred_out' : 'removed';

    // A graduate usually settled most of it; the residue is what they left owing,
    // and a fifth left a balance behind entirely — which is what makes the alumni
    // table's "outstanding at exit" column a real figure rather than a row of
    // zeroes.
    const paidRatio = rand() > 0.8 ? 0.55 + rand() * 0.35 : 1;
    const totalOwed = gh(FEE_BY_CLASS[className]);
    const totalPaid = Math.round(totalOwed * paidRatio);

    const graduationDate = graduationDateFor(year, rand);
    const seq = startSeq + i;

    const student = {
      // Deterministic id, so a re-run updates in place instead of duplicating.
      // The 8xxx range is above anything the counter reaches on its own; the
      // seed calls `syncStudentIdCounter` afterwards so live creates continue
      // past it.
      studentId: `${schoolCode}-${year}-${seq}`,
      studentName: name,
      studentClass: className,
      gender: male ? 'male' : 'female',
      dateOfBirth: new Date(YEARS_BEFORE(between(rand, 14, 17)), between(rand, 0, 11), between(rand, 1, 28)),
      totalOwed,
      totalPaid,
      // Computed here rather than left to the model. `insertMany` does **not**
      // run `pre('save')` hooks, so the hook that normally derives `balance` from
      // `totalOwed - totalPaid` never fires on a bulk write — and a fixture that
      // assumed it did stores a balance of 0 for every student, which makes the
      // entire roster read as "Paid".
      balance: totalOwed - totalPaid,
      deadline: new Date(year, 2, 31),
      academicYear: `${year - 1}/${year}`,
      parents: guardiansFor(rand, surname, i),
      emergencyContacts: emergencyFor(rand),
      status: outcome,
      classHistory: historyFor(rand, className, between(rand, 3, 6)),
      // Backdated so the cohort's `startDate` ($min of createdAt) is the year they
      // enrolled rather than the moment the seed ran.
      createdAt: new Date(year - 5, 8, 5),
      updatedAt: new Date(year, 6, 25),
    };

    if (outcome === 'graduated') {
      student.isAlumni = true;
      student.graduationDate = graduationDate;
      student.graduationYear = String(year);
      student.graduationType = rand() > 0.97 ? 'HONORARY' : 'STANDARD';
      student.certificateNumber = `CERT-${year}-${String(seq - 8000).padStart(6, '0')}`;
      student.honors = honors;
      student.statusReason = '';
      student.statusChangedAt = graduationDate;
    } else if (outcome === 'transferred_out') {
      student.isAlumni = false;
      student.transferOutDate = graduationDate;
      student.transferOutReason = 'Relocation — family moved to Accra';
      // The cohort they were in, not a graduation they completed. `graduationYear`
      // is the cohort identity, so a leaver is counted in the year they would
      // have finished — which is what makes a cohort's transferred and dropped
      // counts real numbers instead of two fields that are always zero.
      student.graduationYear = String(year);
      student.graduationType = null;
      student.certificateNumber = null;
      student.honors = 'NONE';
      student.transferOutRecord = {
        destinationInstitution: pick(rand, [
          'Presbyterian Boys Secondary School, Legon',
          'Accra Academy',
          'Tema Community School No. 4',
          'Mfantsipim School, Cape Coast',
        ]),
        destinationInstitutionType: pick(rand, [
          'PUBLIC_SCHOOL', 'PRIVATE_SCHOOL', 'VOCATIONAL',
        ]),
        contactPerson: `${pick(rand, GIVEN_M)} ${surname}`,
        contactEmail: null,
        contactPhone: phone(rand),
        recordsTransferred: true,
      };
      student.statusReason = 'Transferred to another school';
      student.statusChangedAt = graduationDate;
    } else {
      // Withdrew before completing JHS.
      //
      // `deletedAt` is deliberately left null so the row still appears in the
      // cohort's `dropped` count. Note that this state — `status: 'removed'` with
      // no archive — is not reachable through the current UI, where
      // `archiveStudent` sets both. It is seeded because the cohort detail
      // counts it, and until the app can produce it that counter would otherwise
      // be permanently zero and untestable.
      student.isAlumni = false;
      student.graduationYear = String(year);
      student.graduationType = null;
      student.certificateNumber = null;
      student.honors = 'NONE';
      student.statusReason = 'Withdrew — moved away';
      student.statusChangedAt = graduationDate;
      student.deletedAt = null;
    }

    // A few repeaters per cohort, so `repeating` is a real number too.
    if (rand() > 0.94) student.isRepeating = true;

    students.push(student);
  }

  return students;
};

/**
 * The current roster, for the 2026/2027 term.
 *
 * Fee state is drawn from a weighted mix rather than assigned evenly, because
 * the roster's whole purpose is to separate these groups: `FeeStatusBadge` reads
 * "Paid" or "Overdue" off `balance` and `deadline`, the KPI band's "Fully
 * Cleared" and "Overdue Balances" tiles count them, and the filters select them.
 * A uniform roster would make all four look the same.
 */
export const buildActiveRoster = ({
  schoolCode,
  academicYear,
  count = 120,
  seed = 20260930,
  distribution = { cleared: 0.4, partial: 0.22, owing: 0.2, overdue: 0.13, suspended: 0.05 },
}) => {
  const rand = rng(seed);
  const startSeq = 7001;
  const yearStart = Number(String(academicYear).slice(0, 4));
  const students = [];

  for (let i = 0; i < count; i += 1) {
    // Weighted across the whole class list, so the roster spans Nursery to JHS 3.
    const className = pick(rand, CLASSES);
    const male = rand() > 0.48;
    const given = male ? pick(rand, GIVEN_M) : pick(rand, GIVEN_F);
    const surname = pick(rand, FAMILY);
    const fee = FEE_BY_CLASS[className];
    const totalOwed = gh(fee);

    const roll = rand();
    let cumulative = 0;
    let state = 'cleared';
    for (const [key, weight] of Object.entries(distribution)) {
      cumulative += weight;
      if (roll <= cumulative) {
        state = key;
        break;
      }
    }

    // Overdue needs a deadline in the past; owing needs one still ahead. Getting
    // this backwards produces rows whose badge contradicts its own date, which is
    // exactly the kind of thing that makes a fixture look broken.
    const deadline = state === 'overdue' ? daysAgo(between(rand, 5, 40)) : daysAhead(between(rand, 20, 90));

    let totalPaid;
    if (state === 'cleared') totalPaid = totalOwed;
    else if (state === 'partial') totalPaid = gh(Math.round(fee * (0.2 + rand() * 0.5)));
    else if (state === 'suspended') totalPaid = gh(Math.round(fee * rand() * 0.6));
    else totalPaid = 0;

    const seq = startSeq + i;
    const student = {
      studentId: `${schoolCode}-${yearStart}-${seq}`,
      studentName: `${given} ${surname}`,
      studentClass: className,
      gender: male ? 'male' : 'female',
      dateOfBirth: new Date(
        yearStart - (className.startsWith('Nursery') ? 4 : className.startsWith('Primary') ? 9 : 14),
        between(rand, 0, 11),
        between(rand, 1, 28)
      ),
      totalOwed,
      totalPaid,
      // Derived here, not by the model: `insertMany` skips `pre('save')` hooks, so
      // the hook that normally recomputes `balance` never runs on a bulk write.
      // Storing a literal 0 would make every student read as "Paid" — the roster's
      // fee badges, its "Fully Cleared" tile and its overdue filter would all be
      // wrong in the same direction, and the fixture would look fine.
      balance: totalOwed - totalPaid,
      deadline,
      academicYear,
      parents: guardiansFor(rand, surname, i),
      emergencyContacts: emergencyFor(rand),
      status: state === 'suspended' ? 'suspended' : 'active',
      isRepeating: rand() > 0.95,
      classHistory: rand() > 0.4 ? historyFor(rand, className, between(rand, 1, 4)) : [],
      createdAt: rand() > 0.3 ? new Date(yearStart, 8, between(rand, 5, 25)) : daysAgo(between(rand, 200, 900)),
      updatedAt: daysAgo(between(rand, 0, 40)),
    };

    if (state === 'suspended') {
      student.statusReason = 'Fees unpaid for two terms — school policy';
      student.statusChangedAt = daysAgo(between(rand, 10, 60));
    }

    students.push({ ...student, _feeState: state });
  }

  return students;
};

/**
 * Installment plans for a share of the active roster.
 *
 * The schedule is monthly and genuinely adds up: the remainder from an uneven
 * split goes on the first installment, so the installments sum to
 * `totalAmount` exactly. A plan that does not add up leaves a balance that never
 * reaches zero, and every later report inherits the error.
 */
export const buildPlans = (students, { share = 0.3, seed = 424242, installments = 3 } = {}) => {
  const rand = rng(seed);
  return students
    .filter(() => rand() < share)
    .map((student, i) => {
      const totalAmount = student.totalOwed;
      const base = Math.floor(totalAmount / installments);
      const remainder = totalAmount - base * installments;
      const start = daysAgo(between(rand, 10, 50));

      // Some plans are running, some complete, one or two have been abandoned.
      const planRoll = rand();
      const state = planRoll < 0.7 ? 'active' : planRoll < 0.9 ? 'completed' : 'cancelled';

      const rows = Array.from({ length: installments }, (_, n) => {
        const due = new Date(start);
        due.setDate(due.getDate() + n * 30);
        // Under a completed plan every installment is paid; under a live one the
        // ones already past are paid and the rest pending.
        const paid = state === 'completed' || due.getTime() < Date.now();
        return {
          installmentNumber: n + 1,
          amount: base + (n === 0 ? remainder : 0),
          dueDate: due,
          status: paid ? 'paid' : 'pending',
          paidAt: paid ? due : null,
        };
      });

      return {
        _ref: `PLAN-${String(i + 1).padStart(4, '0')}`,
        planName: 'Termly Installment Plan',
        totalAmount,
        numberOfInstallments: installments,
        interval: 'monthly',
        startDate: start,
        endDate: rows[rows.length - 1].dueDate,
        planStatus: state,
        installments: rows,
        student,
      };
    });
};

/**
 * Settled payments against the plans, so the profile's payment history and the
 * reports' collection totals have real rows to reconcile.
 *
 * `settlement.appliedAt` is set by hand: in normal operation the provider
 * callback claims it, and there is no provider here. Setting it means a later
 * duplicate webhook is a no-op rather than a second credit.
 */
export const buildPayments = (plans, { seed = 98765 } = {}) => {
  const rand = rng(seed);
  const payments = [];
  let n = 1;

  plans.forEach((plan) => {
    const paid = plan.installments.filter((i) => i.status === 'paid');
    paid.forEach((installment) => {
      const network = pick(rand, ['MTN', 'VODAFONE', 'AIRTELTELIGO']);
      payments.push({
        _ref: `PAY-DEMO-${String(n).padStart(5, '0')}`,
        student: plan.student,
        plan,
        amount: installment.amount,
        network,
        at: new Date(installment.paidAt || installment.dueDate),
        n: (n += 1),
      });
    });
  });

  return payments;
};

/** The whole fixture, so `seed.js` has one import and one call. */
export const buildDemoRoster = ({ schoolCode, academicYear }) => {
  const cohorts = [
    { year: 2023, count: 33, seed: 1001 },
    { year: 2024, count: 38, seed: 1002 },
    { year: 2025, count: 41, seed: 1003 },
    { year: 2026, count: 46, seed: 1004 },
  ].map((c) => ({
    year: c.year,
    students: buildCohort({ schoolCode, ...c }),
  }));

  const active = buildActiveRoster({ schoolCode, academicYear });
  const plans = buildPlans(active);
  const payments = buildPayments(plans);

  // The academic years the fixture touches, for the counter sync.
  //
  // Returned rather than parsed back out of the `studentId`s: a school code is
  // free text and routinely contains hyphens (`SCH-DEMO-01-2026-8001`), so
  // `studentId.split('-')[1]` is the code, not the year — which is exactly the
  // bug that had the seed raising a counter named "DEMO" instead of "2026".
  const yearStart = Number(String(academicYear).slice(0, 4));
  const years = [...new Set([...cohorts.map((c) => String(c.year)), String(yearStart)])];

  return { cohorts, active, plans, payments, years };
};

export default buildDemoRoster;
