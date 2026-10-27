import express from 'express';
import { authenticate, authorize } from '../middleware/authenticate.js';
import { initiateManualPaymentController, confirmManualPaymentController } from '../controllers/manualPayment.controller.js';

const requireManualPaymentAdmin = authorize("super_admin", "school_admin", "accountant");

const router = express.Router();

router.post('/pay/:token/manual-initiate', initiateManualPaymentController);
router.post('/admin/manual-payments/confirm', authenticate, requireManualPaymentAdmin, confirmManualPaymentController);

export const manualPaymentRoute = router;
