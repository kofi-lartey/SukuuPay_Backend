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
import { webhookRoute } from './webhooks.routes.js';
import { publicAdRoute } from './schoolAd.routes.js';

const router = Router();

// The same health router the root mount uses, so /api/health reports the same
// dependency and version detail the root endpoint does.
router.use('/', healthRoute);

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

// WhatsApp and the third-party callback routers declare absolute paths, so they
// are mounted at the root of this router: they answer /api/whatsapp/* and
// /api/webhooks/* as well as the root-level URLs their providers are
// configured with.
router.use('/', whatsappRoute);
router.use('/', webhookRoute);

export default router;
