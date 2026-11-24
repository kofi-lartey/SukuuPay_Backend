import { Router } from 'express';
import { authRoute } from './authRoutes.js';
import { userRoute } from './userRoutes.js';
import { schoolRoute } from './school.routes.js';
import { studentRoute } from './student.routes.js';
import { paymentRoute } from './payment.routes.js';
import { paymentPlanRoute } from './paymentPlan.routes.js';
import { manualPaymentRoute } from './manualPayment.routes.js';
import { emailMessagingRoute } from './emailMessaging.routes.js';
import { analyticsRoute } from './analytics.routes.js';
import { reportsRoute } from './reports.routes.js';
import { auditLogRoute } from './auditLog.routes.js';
import { idCardRoute } from './idCard.routes.js';
import { idCardTemplateRoute } from './idCardTemplate.routes.js';
import { uploadRoute } from './upload.routes.js';
import { notificationRoute } from './notification.routes.js';
import { parentMessageRoute } from './parentMessage.routes.js';
import { parentRoute } from './parent.routes.js';
import lmsStudentRoute from './lmsStudent.routes.js';
import { teacherRoute } from './teacher.routes.js';
import lmsRoute from './lms.routes.js';
import { settingsRoute } from './settings.routes.js';
import { adminRoute } from './admin.routes.js';
import { adminAttendanceRoute } from './admin.attendance.routes.js';
import { adminRecordsRoute } from './admin.records.routes.js';
import { adminTimetableRoute } from './admin.timetable.routes.js';
import { adminAcademicRoute } from './admin.academic.routes.js';
import { healthRoute } from './health.routes.js';
import { whatsappRoute } from './whatsapp.routes.js';
import { smsRoute } from './sms.routes.js';
import { smsRequestRoute } from './smsRequest.routes.js';
import { webhookRoute } from './webhooks.routes.js';
import { publicAdRoute, schoolAdRoute } from './schoolAd.routes.js';
import { publicSchoolRoute } from './public.routes.js';
import { maintenanceGuard } from '../middleware/maintenance.js';
import { communityRoute } from './community.routes.js';
import { schoolVerificationRoute } from './schoolVerification.routes.js';

const router = Router();

// The same health router the root mount uses, so /api/health reports the same
// dependency and version detail the root endpoint does.
router.use('/', healthRoute);

// Maintenance, mounted on `/api` and *after* `healthRoute`.
//
// Three things about that placement, all load-bearing:
//
//   - **On `/api`, never globally.** Payment and WhatsApp callbacks are mounted at
//     the root in `index.js` before `/api`, so this cannot reach them. A global guard
//     would refuse a settlement callback mid-migration — turning a planned
//     outage into lost money, silently, because the provider's retry would be refused
//     too.
//   - **After `healthRoute`,** so `GET /api/health` answers before the guard runs.
//     That is the path `utils/cron.js` probes, and a deliberate `maintenance: "on"`
//     should not then log a health failure every cycle.
//   - **Before every other router,** so a write is refused before it reaches a
//     controller at all, rather than partway through one.
router.use(maintenanceGuard);

router.use('/', authRoute);
router.use('/', userRoute);
router.use('/', schoolRoute);
router.use('/', schoolVerificationRoute);
router.use('/', studentRoute);
router.use('/', paymentRoute);
router.use('/', paymentPlanRoute);
router.use('/', emailMessagingRoute);
router.use('/', analyticsRoute);
router.use('/', reportsRoute);
router.use('/audit-logs', auditLogRoute);
router.use('/id-cards', idCardRoute);
router.use('/id-card-templates', idCardTemplateRoute);
router.use('/upload', uploadRoute);
router.use('/notifications', notificationRoute);
// Parent → school messaging. Mounted at the root rather than under `/notifications`
// because these are the *record* a notification points at: the alerts expire after 90
// days by TTL and carry no state, while a fee dispute raised by a parent has to
// outlive them and be answerable. Adjacent in the stack, different thing.
router.use('/', parentMessageRoute);
// The parent portal's academic reads — attendance, report cards, timetable.
// Mounted at `/pay`, where the token in the path is the credential, so these
// answer `/api/pay/:token/attendance` and so on. Adjacent to the fee surface it
// shares a token with, and separate from it: `payment.routes.js` owns money and
// `parent.routes.js` owns the register and the report card.
router.use('/pay', parentRoute);
router.use('/pay', lmsStudentRoute);

// Student Community — posts, comments, clubs, events, chat.
// Mounted at `/community` because that is what the frontend calls it, and it is a
// first-class student surface beside the parent pay portal and the teacher portal.
// The communityAuth middleware in each route already excludes parent roles.
router.use('/community', communityRoute);

// The teacher portal — a sibling of the parent portal rather than of the admin
// console. It answers `/api/teacher/*` and carries its own gate
// (`authenticate`, `requireTeacher`, `requireSchool`) because a teacher is
// neither the platform owner nor a parent: nothing on these paths is owned by
// `admin.routes.js`, so no path collides and no mount ordering is load-bearing.
//
// It is registered here, adjacent to the parent portal, because both surfaces
// are scoped to the signed-in caller and resolve their own scope from the token
// — neither takes an id in the query. That is the family they belong to.
router.use('/teacher', teacherRoute);
router.use('/teacher/lms', lmsRoute);

router.use('/settings', settingsRoute);

/**
 * The school's own console for academics — attendance, report cards,
 * timetables. Mounted at `/admin` but **before** the platform console
 * (`adminRoute`) below.
 *
 * ## Why before, and why not inside `admin.routes.js`
 *
 * `admin.routes.js` is the *platform* console: it begins with
 * `adminRoute.use(authenticate, authorize('super_admin'))`, which runs for every
 * request that reaches that router. A teacher taking a roll in Tamale is not the
 * platform owner, and that gate would answer `403` for `/admin/attendance/bulk`
 * *before* this router ever matched the path — Express does not fall through to
 * the next `/admin` mount once a middleware sends a response.
 *
 * Mounting these three routers ahead of `adminRoute` fixes both halves of that:
 * a path they own (`/attendance/*`, `/records/*`, `/timetable`) is matched and
 * authorised by them first, while a path owned by the platform (`/dashboard`,
 * `/schools/:id`, …) matches no route here, falls through, and lands on
 * `adminRoute` with its `super_admin` gate intact. The two routers are also
 * deliberately kept out of the same file: `admin.routes.js` documents its own
 * boot-failure hazard (an undefined import takes down `/admin` and everything
 * that mounts it), so adding three more imports to it would widen that blast
 * radius for no benefit they cannot have in their own files.
 *
 * No path collides in either direction — the platform console registers nothing
 * under `/attendance`, `/records` or `/timetable` — which is what makes the
 * ordering safe to lean on.
 */
router.use('/admin', adminAttendanceRoute);
router.use('/admin', adminRecordsRoute);
router.use('/admin', adminTimetableRoute);
// The headmaster's academic console — grade approval, report card review and
// publication, class and subject-teacher management, timetables and the
// oversight dashboard. Mounted here, adjacent to the three academic routers
// above and before the platform console, for exactly the reason they are: it
// gates many of its routes on `requireTeacher`, and `adminRoute` below would
// answer `403` for a teacher before this router could ever match a path. Its
// paths (`/academic`, `/grades`, `/reports/{compile,publish,…}`, `/classes`,
// `/timetables`) collide with none of the platform console's.
router.use('/admin', adminAcademicRoute);

router.use('/', manualPaymentRoute);
router.use('/admin', adminRoute);
// The unauthenticated ad slider.
router.use('/', publicAdRoute);
// The unauthenticated school surface — the homepage logo carousel.
// Separate from the ad router: a different resource, a different
// projection to protect.
router.use('/', publicSchoolRoute);
// A school's own advertisement requests. Mounted separately from the public router
// because it is `authenticate`d — and kept adjacent so the two halves of the ad feature
// stay in one file, where the contrast between "may read everything" and "may read only
// its own" is the thing a reader is meant to notice.
router.use('/', schoolAdRoute);

// WhatsApp, SMS and the third-party callback routers declare absolute paths, so
// they are mounted at the root of this router: they answer /api/whatsapp/*,
// /api/sms/* and /api/webhooks/* as well as the root-level URLs their providers
// are configured with.
router.use('/', whatsappRoute);
router.use('/', smsRoute);
// Regulated SMS credit purchase. Adjacent to `smsRoute` rather than inside it: that one
// is about *sending* messages and is mounted at the root, and this one is about buying
// the credit to send them with. Both answer `/sms-*`, and keeping them in separate
// routers means the purchase flow can be read without the sending flow's history.
router.use('/', smsRequestRoute);

export default router;
