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
import { settingsRoute } from './settings.routes.js';
import { adminRoute } from './admin.routes.js';
import { healthRoute } from './health.routes.js';
import { whatsappRoute } from './whatsapp.routes.js';
import { smsRoute } from './sms.routes.js';
import { webhookRoute } from './webhooks.routes.js';
import { publicAdRoute } from './schoolAd.routes.js';
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
router.use('/settings', settingsRoute);
router.use('/admin', adminRoute);
router.use('/', publicAdRoute);

// WhatsApp, SMS and the third-party callback routers declare absolute paths, so
// they are mounted at the root of this router: they answer /api/whatsapp/*,
// /api/sms/* and /api/webhooks/* as well as the root-level URLs their providers
// are configured with.
router.use('/', whatsappRoute);
router.use('/', smsRoute);
router.use('/', webhookRoute);

export default router;
