import {
  sendSms,
  previewSmsHandler,
  previewAudienceHandler,
  bulkSendSms,
  processSmsJob,
  drainSmsQueue,
  getSmsJob,
  listSmsJobs,
  cancelSmsJob,
  listSmsMessages,
  listTemplates,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  previewTemplate,
  getSmsCredits,
  topUpSmsCredits,
} from '../services/sms.service.js';
import { idempotencyKeyFrom } from '../utils/idempotency.js';

/**
 * Every handler is a thin try/catch over the service.
 *
 * The catch block is the project's convention: `error.status` carries the HTTP
 * code the service chose and `error.code` the machine-readable one, so a
 * `402 INSUFFICIENT_SMS_CREDIT` reaches the client as a 402 rather than a 500.
 * The service is where the decisions live; a controller that second-guesses them
 * is where the status code and the error code start disagreeing.
 */

// ── POST /sms/send/:studentId — message a student's parent(s) ──
export const sendSmsController = async (req, res) => {
  try {
    const result = await sendSms(req.params.studentId, req.body, req.user, {
      idempotencyKey: idempotencyKeyFrom(req),
    });

    // A replay is a 200, not a 201: nothing was created this time. A client
    // retrying after a network blip needs to be able to tell "it went through,
    // the first response was lost" from "I just sent this", and the status code
    // is the only place that difference is visible.
    return res.status(result.replayed ? 200 : 201).json({
      success: true,
      message: result.replayed
        ? 'SMS already sent for this Idempotency-Key'
        : 'SMS sent successfully',
      data: result.data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
      ...error.meta,
    });
  }
};

// ── GET /sms/preview/:studentId — cost and rendered copy, no send ──
export const previewSmsController = async (req, res) => {
  try {
    const preview = await previewSmsHandler(req.params.studentId, req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS preview generated',
      data: preview,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /sms/audience/preview — how many parents a rule reaches ──
export const previewAudienceController = async (req, res) => {
  try {
    const preview = await previewAudienceHandler(req.body.schoolId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Audience preview generated',
      data: preview,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /sms/bulk — broadcast to a resolved audience ──
export const bulkSendSmsController = async (req, res) => {
  try {
    const result = await bulkSendSms(req.body, req.user, {
      idempotencyKey: idempotencyKeyFrom(req),
    });

    return res.status(result.replayed ? 200 : 202).json({
      success: true,
      message: result.replayed
        ? 'Broadcast already queued for this Idempotency-Key'
        : 'Broadcast accepted and queued',
      data: result.data,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
      ...error.meta,
    });
  }
};

// ── GET /sms/jobs — a school's broadcast history ──
export const listSmsJobsController = async (req, res) => {
  try {
    const result = await listSmsJobs(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS jobs retrieved successfully',
      data: result.jobs,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── GET /sms/jobs/:jobId — read one broadcast ──
export const getSmsJobController = async (req, res) => {
  try {
    const job = await getSmsJob(req.params.jobId, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS job retrieved successfully',
      data: job,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /sms/jobs/:jobId/cancel — stop a queued broadcast ──
export const cancelSmsJobController = async (req, res) => {
  try {
    const result = await cancelSmsJob(req.params.jobId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Broadcast cancelled',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /sms/jobs/:jobId/process — run one job now ──
//
// Exposed as a route as well as being driven by the queue drain, so a
// deployment with no scheduler configured can still get a broadcast out by
// triggering it. The `queued` claim inside `processSmsJob` is what stops a
// manual trigger and the drain from running the same job twice.
export const processSmsJobController = async (req, res) => {
  try {
    const result = await processSmsJob(req.params.jobId);

    if (!result) {
      return res.status(409).json({
        success: false,
        message: 'This job is not queued — it has already been run, cancelled, or is not due yet',
        code: 'JOB_NOT_RUNNABLE',
      });
    }

    return res.status(200).json({
      success: true,
      message: 'Broadcast processed',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── POST /sms/jobs/drain — run everything currently due ──
//
// Super-admin only: it is a scheduler entry point with no school scope, and it
// spends every school's credit. A school admin triggering it would let one
// school occupy the worker ahead of another.
export const drainSmsQueueController = async (req, res) => {
  try {
    const result = await drainSmsQueue();

    return res.status(200).json({
      success: true,
      message: result.skipped ? 'A drain is already running' : 'Queue drained',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── GET /sms/messages — the per-message delivery history ──
export const listSmsMessagesController = async (req, res) => {
  try {
    const result = await listSmsMessages(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS messages retrieved successfully',
      data: result.messages,
      meta: result.meta,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── Templates ──

export const listTemplatesController = async (req, res) => {
  try {
    const templates = await listTemplates(req.query, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS templates retrieved successfully',
      data: templates,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const createTemplateController = async (req, res) => {
  try {
    const template = await createTemplate(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: 'Template created successfully',
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const updateTemplateController = async (req, res) => {
  try {
    const template = await updateTemplate(req.params.templateId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Template updated successfully',
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const deleteTemplateController = async (req, res) => {
  try {
    const result = await deleteTemplate(req.params.templateId, req.user);

    return res.status(200).json({
      success: true,
      message: 'Template deleted successfully',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const previewTemplateController = async (req, res) => {
  try {
    const preview = await previewTemplate(req.body, req.user);

    return res.status(200).json({
      success: true,
      message: 'Template preview generated',
      data: preview,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

// ── Credits ──

export const getSmsCreditsController = async (req, res) => {
  try {
    const credits = await getSmsCredits(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: 'SMS credits retrieved successfully',
      data: credits,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const topUpSmsCreditsController = async (req, res) => {
  try {
    const result = await topUpSmsCredits(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: 'SMS credit added successfully',
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};
