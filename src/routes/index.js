import { Router } from 'express';
import { authRoute } from './authRoutes.js';
import { userRoute } from './userRoutes.js';
import { schoolRoute } from './school.routes.js';
import { studentRoute } from './student.routes.js';
import { paymentRoute } from './payment.routes.js';
import { paymentPlanRoute } from './paymentPlan.routes.js';
import { emailMessagingRoute } from './emailMessaging.routes.js';
import { analyticsRoute } from './analytics.routes.js';
import { reportsRoute } from './reports.routes.js';
import { auditLogRoute } from './auditLog.routes.js';
import { idCardRoute } from './idCard.routes.js';
import { uploadRoute } from './upload.routes.js';
import { notificationRoute } from './notification.routes.js';
import { parentMessageRoute } from './parentMessage.routes.js';
import { settingsRoute } from './settings.routes.js';
import { adminRoute } from './admin.routes.js';
import { healthRoute } from './health.routes.js';
import { whatsappRoute } from './whatsapp.routes.js';
import { smsRoute } from './sms.routes.js';
import { smsRequestRoute } from './smsRequest.routes.js';
import { webhookRoute } from './webhooks.routes.js';
import { publicAdRoute, schoolAdRoute } from './schoolAd.routes.js';
import { maintenanceGuard } from '../middleware/maintenance.js';

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
//     would refuse a Hubtel settlement callback mid-migration — turning a planned
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
router.use('/', studentRoute);
router.use('/', paymentRoute);
router.use('/', paymentPlanRoute);
router.use('/', emailMessagingRoute);
router.use('/', analyticsRoute);
router.use('/', reportsRoute);
router.use('/audit-logs', auditLogRoute);
router.use('/id-cards', idCardRoute);
router.use('/upload', uploadRoute);
router.use('/notifications', notificationRoute);
// Parent → school messaging. Mounted at the root rather than under `/notifications`
// because these are the *record* a notification points at: the alerts expire after 90
// days by TTL and carry no state, while a fee dispute raised by a parent has to
// outlive them and be answerable. Adjacent in the stack, different thing.
router.use('/', parentMessageRoute);
router.use('/settings', settingsRoute);
router.use('/admin', adminRoute);
// The unauthenticated ad slider.
router.use('/', publicAdRoute);
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
router.use('/', webhookRoute);

export default router;
