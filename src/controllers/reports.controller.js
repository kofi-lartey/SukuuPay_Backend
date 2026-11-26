import {
  getDailyReport,
  getTermReport,
  getOutstandingReport,
  getComplianceReport,
  getPaymentMethodsReport,
  getClassCollectionsReport,
  getParentContactsReport,
  getOverdueReport,
  getHeadmasterMonthlyReport,
  createTemplate,
  listTemplates,
  createJob,
  getJob,
  listJobs,
} from "../services/reports.service.js";
import { sendReportFile } from "../utils/reportExport.js";
import { formatCedis } from "../utils/formatters.js";

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

const summarySection = (summary, fields) => ({
  name: "Summary",
  title: "Summary",
  columns: fields,
  rows: fields.map((f) => ({
    metric: f.header,
    value: summary?.[f.key] ?? null,
    display:
      f.display === "money" ? formatCedis(summary?.[f.key]) : String(summary?.[f.key] ?? ""),
  })),
});

/**
 * Report definitions. Each entry pairs the service builder with the column
 * layout used when the report is exported, so all nine endpoints share one
 * `format` dispatch and cannot drift apart on export behaviour.
 */
const REPORTS = {
  daily: {
    build: getDailyReport,
    message: "Daily collection report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "totalCollected", header: "Total Collected", display: "money" },
        { key: "transactionCount", header: "Transactions" },
        { key: "averagePayment", header: "Average Payment", display: "money" },
      ]),
      {
        name: "Payments",
        title: "Payments received",
        columns: [
          { key: "receiptNumber", header: "Receipt" },
          { key: "invoiceNumber", header: "Invoice" },
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentCode", header: "Student ID" },
          { key: "studentClass", header: "Class" },
          { key: "paymentMethod", header: "Method" },
          { key: "provider", header: "Provider" },
          { key: "amount", header: "Amount (pesewas)" },
          { key: "amountDisplay", header: "Amount" },
          { key: "status", header: "Status" },
          { key: "description", header: "Description", width: 40 },
          { key: "completedAt", header: "Completed At" },
        ],
        rows: r.rows,
      },
      {
        name: "By Method",
        title: "Totals by payment method",
        columns: [
          { key: "paymentMethod", header: "Method" },
          { key: "amountDisplay", header: "Amount" },
          { key: "count", header: "Payments" },
        ],
        rows: r.byMethod,
      },
    ],
  },

  term: {
    build: getTermReport,
    message: "Term report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "studentCount", header: "Students" },
        { key: "expected", header: "Expected", display: "money" },
        { key: "collectedToDate", header: "Collected To Date", display: "money" },
        { key: "collectedInWindow", header: "Collected In Term", display: "money" },
        { key: "outstanding", header: "Outstanding", display: "money" },
        { key: "collectionRate", header: "Collection Rate (%)" },
      ]),
      {
        name: "By Class",
        title: "Collections by class",
        columns: [
          { key: "className", header: "Class" },
          { key: "studentCount", header: "Students" },
          { key: "expectedDisplay", header: "Expected" },
          { key: "collectedDisplay", header: "Collected" },
          { key: "balanceDisplay", header: "Balance" },
          { key: "collectionRate", header: "Rate (%)" },
        ],
        rows: r.rows,
      },
      {
        name: "Monthly",
        title: "Monthly trend",
        columns: [
          { key: "period", header: "Period" },
          { key: "collectedDisplay", header: "Collected" },
          { key: "count", header: "Payments" },
        ],
        rows: r.monthly,
      },
      {
        name: "Top Owing",
        title: "Top owing students",
        columns: [
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentClass", header: "Class" },
          { key: "balanceDisplay", header: "Balance" },
        ],
        rows: r.topOwing,
      },
    ],
  },

  outstanding: {
    build: getOutstandingReport,
    message: "Outstanding balances report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "studentCount", header: "Students Owing" },
        { key: "totalOutstanding", header: "Total Outstanding", display: "money" },
        { key: "fullyUnpaidCount", header: "No Payments" },
        { key: "partiallyPaidCount", header: "Partially Paid" },
      ]),
      {
        name: "Outstanding",
        title: "Outstanding balances",
        columns: [
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentId", header: "Student ID" },
          { key: "studentClass", header: "Class" },
          { key: "totalOwed", header: "Billed (pesewas)" },
          { key: "totalPaid", header: "Paid (pesewas)" },
          { key: "balanceDisplay", header: "Balance" },
          { key: "oldestDueDate", header: "Oldest Due" },
          { key: "daysOutstanding", header: "Days Outstanding" },
          { key: "primaryParentName", header: "Primary Parent" },
          { key: "primaryParentPhone", header: "Parent Phone" },
        ],
        rows: r.rows,
      },
    ],
  },

  compliance: {
    build: getComplianceReport,
    message: "Installment compliance report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "overallComplianceRate", header: "Overall Compliance (%)" },
        { key: "totalPlans", header: "Plans" },
        { key: "onTrack", header: "On Track" },
        { key: "approachingDue", header: "Approaching Due" },
        { key: "overdue", header: "Overdue" },
        { key: "completed", header: "Completed" },
        { key: "defaulted", header: "Defaulted" },
        { key: "pendingAcceptance", header: "Pending Acceptance" },
      ]),
      {
        name: "Plans",
        title: "Plan compliance",
        columns: [
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentClass", header: "Class" },
          { key: "planName", header: "Plan" },
          { key: "planStatus", header: "Status" },
          { key: "totalInstallments", header: "Installments" },
          { key: "installmentsPaidOnTime", header: "Paid On Time" },
          { key: "installmentsOverdue", header: "Overdue" },
          { key: "complianceRate", header: "Rate (%)" },
          { key: "bucket", header: "Bucket" },
        ],
        rows: r.rows,
      },
    ],
  },

  "payment-methods": {
    build: getPaymentMethodsReport,
    message: "Payment method breakdown retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "totalCollected", header: "Total Collected", display: "money" },
        { key: "transactionCount", header: "Payments" },
        { key: "groupCount", header: "Groups" },
      ]),
      {
        name: "Breakdown",
        title: `Collected by ${r.period.groupBy}`,
        columns: [
          { key: "label", header: "Group" },
          { key: "amountDisplay", header: "Amount" },
          { key: "count", header: "Payments" },
          { key: "percentage", header: "Share (%)" },
        ],
        rows: r.rows,
      },
    ],
  },

  "class-collections": {
    build: getClassCollectionsReport,
    message: "Class-wise collections report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "classCount", header: "Classes" },
        { key: "studentCount", header: "Students" },
        { key: "totalExpected", header: "Total Expected", display: "money" },
        { key: "totalCollected", header: "Total Collected", display: "money" },
        { key: "totalBalance", header: "Total Balance", display: "money" },
        { key: "collectionRate", header: "Collection Rate (%)" },
      ]),
      {
        name: "By Class",
        title: "Class-wise collections",
        columns: [
          { key: "className", header: "Class" },
          { key: "studentCount", header: "Students" },
          { key: "expectedDisplay", header: "Expected" },
          { key: "collectedDisplay", header: "Collected" },
          { key: "balanceDisplay", header: "Balance" },
          { key: "collectionRate", header: "Rate (%)" },
        ],
        rows: r.rows,
      },
    ],
  },

  "parent-contacts": {
    build: getParentContactsReport,
    message: "Parent contact list retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "studentCount", header: "Students" },
        { key: "contactCount", header: "Contacts" },
        { key: "uniquePhoneCount", header: "Unique Numbers" },
        { key: "studentsOwing", header: "Students Owing" },
      ]),
      {
        name: "Contacts",
        title: "Parent contacts",
        columns: [
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentRef", header: "Student ID" },
          { key: "studentClass", header: "Class" },
          { key: "parentName", header: "Parent" },
          { key: "relationship", header: "Relationship" },
          { key: "phone", header: "Phone" },
          { key: "email", header: "Email" },
          { key: "isPrimary", header: "Primary" },
          { key: "balanceDisplay", header: "Balance" },
        ],
        rows: r.rows,
      },
    ],
  },

  overdue: {
    build: getOverdueReport,
    message: "Overdue students report retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "totalOverdue", header: "Overdue Students" },
        { key: "totalOverdueAmount", header: "Overdue Amount", display: "money" },
        { key: "criticalCount", header: "Critical" },
        { key: "warningCount", header: "Warning" },
        { key: "avgDaysOverdue", header: "Avg Days Overdue" },
      ]),
      {
        name: "Overdue",
        title: "Overdue students",
        columns: [
          { key: "studentName", header: "Student", width: 24 },
          { key: "studentId", header: "Student ID" },
          { key: "studentClass", header: "Class" },
          { key: "planName", header: "Plan" },
          { key: "daysOverdue", header: "Days Overdue" },
          { key: "severity", header: "Severity" },
          { key: "totalOverdueAmountDisplay", header: "Amount Due" },
          { key: "primaryParentName", header: "Primary Parent" },
          { key: "primaryParentPhone", header: "Parent Phone" },
        ],
        rows: r.rows,
      },
    ],
  },

  "headmaster-monthly": {
    build: getHeadmasterMonthlyReport,
    message: "Monthly headmaster summary retrieved successfully",
    sections: (r) => [
      summarySection(r.summary, [
        { key: "collected", header: "Collected This Month", display: "money" },
        { key: "previousCollected", header: "Collected Last Month", display: "money" },
        { key: "monthOnMonthChange", header: "Change", display: "money" },
        { key: "totalOutstanding", header: "Total Outstanding", display: "money" },
        { key: "collectionRate", header: "Collection Rate (%)" },
      ]),
      {
        name: "Detail",
        title: `Headmaster summary — ${r.period.month}`,
        columns: [
          { key: "metric", header: "Metric", width: 32 },
          { key: "value", header: "Value (pesewas)" },
          { key: "display", header: "Value" },
        ],
        rows: r.rows,
      },
    ],
  },
};

/**
 * Builds one controller: run the report, then either stream the requested file
 * or return the standard JSON envelope.
 */
const makeController = (name) => {
  const { build, message, sections } = REPORTS[name];

  return asyncHandler(async (req, res) => {
    const result = await build(req.params.schoolId, req.query, req.user);
    const format = (req.query.format || "").toLowerCase();

    if (format) {
      return sendReportFile(res, {
        report: name,
        schoolId: req.params.schoolId,
        format,
        sections: sections(result),
      });
    }

    return res.status(200).json({
      success: true,
      message,
      data: result,
      meta: result.meta,
    });
  });
};

export const getDailyReportController = makeController("daily");
export const getTermReportController = makeController("term");
export const getOutstandingReportController = makeController("outstanding");
export const getComplianceReportController = makeController("compliance");
export const getPaymentMethodsReportController = makeController("payment-methods");
export const getClassCollectionsReportController = makeController("class-collections");
export const getParentContactsReportController = makeController("parent-contacts");
export const getOverdueReportController = makeController("overdue");
export const getHeadmasterMonthlyReportController = makeController("headmaster-monthly");

// ──────────────────── Wave 3: custom audit templates & report jobs ────────────────────

export const createTemplateController = asyncHandler(async (req, res) => {
  const template = await createTemplate(req.body, req.user);
  return res.status(201).json({
    success: true,
    message: "Report template created successfully",
    data: template,
  });
});

export const listTemplatesController = asyncHandler(async (req, res) => {
  const schoolId = req.user && req.user.schoolId ? req.user.schoolId : null;
  const templates = await listTemplates(schoolId);
  return res.status(200).json({
    success: true,
    message: "Report templates retrieved successfully",
    data: templates,
  });
});

export const createJobController = asyncHandler(async (req, res) => {
  const job = await createJob(req.body.templateId, req.user, req.body.parameters);
  return res.status(201).json({
    success: true,
    message: "Report job queued successfully",
    data: job,
  });
});

export const getJobController = asyncHandler(async (req, res) => {
  const job = await getJob(req.params.id);
  return res.status(200).json({
    success: true,
    message: "Report job retrieved successfully",
    data: {
      ...job,
      downloadUrl: job.fileUrl || null,
      expiresAt: job.expiresAt || null,
    },
  });
});

export const listJobsController = asyncHandler(async (req, res) => {
  const schoolId = req.user && req.user.schoolId ? req.user.schoolId : null;
  const result = await listJobs(schoolId, req.query);
  return res.status(200).json({
    success: true,
    message: "Report jobs retrieved successfully",
    data: result.jobs,
    meta: {
      page: result.page,
      perPage: result.perPage,
      total: result.total,
      totalPages: result.totalPages,
    },
  });
});

export { REPORTS };
