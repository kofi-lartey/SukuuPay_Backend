import { Router } from "express";
import {
  quoteSmsRequest,
  createSmsRequest,
  listRequestsForSchool,
  getSmsRequestForSchool,
} from "../services/smsPurchaseRequest.service.js";
import { authenticate, authorize } from "../middleware/authenticate.js";
import { rateLimit } from "../middleware/rateLimit.js";
import { validate } from "../middleware/validate.js";
import {
  quoteSmsRequestSchema,
  createSmsRequestSchema,
  listSmsRequestsSchema,
  smsRequestIdParamSchema,
} from "../validations/smsRequest.validation.js";

export const smsRequestRoute = Router();

/**
 * Who may ask.
 *
 * `school_admin` and `accountant` — the same two roles `findSchoolRecipients` alerts
 * and the same two the parent-message inbox admits. A bursar spends the school's money
 * on SMS, so this is a money permission and it is granted exactly where the codebase
 * already puts money permissions for a school.
 */
const requireBuyer = authorize("school_admin", "accountant");

/**
 * Rate limits.
 *
 * Both use the limiter's **default identity**, which `resolveIdentity` resolves to
 * `req.user._id` for an authenticated caller. That is the right granularity without
 * asking for it: a school sits behind one NAT, so an IP-keyed limit either lets one
 * bursar lock out the whole finance office or — with a generous ceiling — leaves a
 * shared egress open to a retry loop.
 *
 * (`keyBy` only accepts `'ip'` and `'token'`; anything else falls through to the same
 * authenticated branch. Passing a third value would have read as deliberate and been a
 * silent no-op.)
 *
 * The create limit is tight on purpose. Six an hour is far more than anyone needs to
 * buy credit, and every request beyond it issues a **real MoMo prompt**: a frontend
 * retry loop would put six prompts an hour on a bursar's phone, with money sitting
 * unapproved behind each one until a human acts.
 */
const quoteLimit = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: 'Too many price checks. Please wait a minute.',
});

const createLimit = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 6,
  message:
    'You have requested several SMS purchases this hour. Please wait, or contact support if you need more.',
});

/**
 * `POST /api/sms-requests/quote` — the price, before the school agrees to anything.
 *
 * Ahead of `POST /` because Express matches in declaration order and both share the
 * two-segment prefix; `GET /:requestId` is a `GET` so there is no collision with
 * `POST /`, but this is written in path order so that stays true.
 */
smsRequestRoute.post(
  "/sms-requests/quote",
  authenticate,
  requireBuyer,
  quoteLimit,
  validate(quoteSmsRequestSchema),
  async (req, res) => {
    try {
      const quote = await quoteSmsRequest(req.body);
      return res.status(200).json({ success: true, data: quote });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

// `POST /api/sms-requests` — creates the request and prompts for payment.
smsRequestRoute.post(
  "/sms-requests",
  authenticate,
  requireBuyer,
  createLimit,
  validate(createSmsRequestSchema),
  async (req, res) => {
    try {
      const result = await createSmsRequest(req.body, req.user);

      return res.status(201).json({
        success: true,
        message:
          "Check your phone for the MTN payment prompt and approve it. An administrator will then release your credit.",
        data: {
          requestId: result.request.requestId,
          units: result.request.units,
          unitPricePes: result.request.unitPricePes,
          totalPes: result.request.totalPes,
          status: result.request.status,
          paymentReference: result.reference,
          prompted: result.prompted,
        },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

// `GET /api/sms-requests` — the school's own purchase history.
smsRequestRoute.get(
  "/sms-requests",
  authenticate,
  requireBuyer,
  validate(listSmsRequestsSchema, "query"),
  async (req, res) => {
    try {
      const { page, perPage, status } = req.query;
      const result = await listRequestsForSchool({
        schoolId: req.user.schoolId,
        status,
        page: Number(page),
        perPage: Number(perPage),
      });

      return res.status(200).json({
        success: true,
        data: result.rows,
        meta: {
          page: result.page,
          perPage: result.perPage,
          total: result.total,
          totalPages: Math.ceil(result.total / result.perPage),
        },
      });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

/**
 * `GET /api/sms-requests/:requestId` — one request, for the status poll.
 *
 * The state that matters changes on an MTN webhook, independently of the browser: a
 * bursar approves the prompt on their *phone*, closes the tab, and comes back later.
 * Without a single-request read there is nothing to re-fetch and the page can only show
 * what it knew when it was opened.
 *
 * Scoped by `schoolId` in the service, not trusted from the parameter — a bursar who
 * guessed another school's `SMS-REQ-` reference would otherwise read their purchase
 * history and payment reference.
 */
smsRequestRoute.get(
  "/sms-requests/:requestId",
  authenticate,
  requireBuyer,
  validate(smsRequestIdParamSchema, "params"),
  async (req, res) => {
    try {
      const request = await getSmsRequestForSchool(
        req.params.requestId,
        req.user.schoolId
      );

      return res.status(200).json({ success: true, data: request });
    } catch (error) {
      return res
        .status(error.status || 500)
        .json({ success: false, message: error.message });
    }
  }
);

export default smsRequestRoute;