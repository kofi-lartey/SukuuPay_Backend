/**
 * Feature catalog for tier-based access control.
 *
 * Features are grouped by tier and inherited upwards.
 *
 * ### Tier definitions
 * - `marketing`: The published tier name (Starter, Growth, Campus)
 * - `server`: Corresponding server subscription.plan value
 * - `inheritance`: Parent tier for inheritance (null for base)
 *
 * ### Feature categories
 * - `core`: Base tier features available to all tiers
 * - `tierX`: Tier-specific features, inherited by all higher tiers
 *
 * ### Feature flag mapping
 * `installments`, `idCards`, `whatsapp`, `apiAccess` are the existing per-school featureFlags.
 * These are mapped through tiers for cleaner role/feature logic.
 */

/**
 * Feature IDs — unique keys across the product.
 *
 * Example usage: `featureFlags.installments` can now refer to `FEATURES.installments`.
 * The feature flags in the school model are duplicated here so tier logic
 * can resolve everything in one place, and UI (frontend) does not need
 * a full copy of the server model.
 */
import { normalizePlan } from '../config/constants.js';

export const FEATURES = {
  // Core platform (available to all tiers)
  bulkStudentUpload: {
    id: 'bulkStudentUpload',
    label: 'Bulk Student Upload (CSV/Excel)',
    tier: 'core',
    module: 'records',
    description: 'Import students in bulk using CSV or Excel.',
  },

  momoPayments: {
    id: 'momoPayments',
    label: 'All MoMo Networks (MTN, Telecel, AT)',
    tier: 'core',
    module: 'payments',
    description: 'Receive payments from parents via MTN, Telecel, and AT Mobile Money.',
  },

  smsReminders: {
    id: 'smsReminders',
    label: 'Automated SMS Fee Reminders',
    tier: 'core',
    module: 'outreach',
    description: 'Send automated SMS reminders to parents about outstanding fees.',
  },

  pdfReceipts: {
    id: 'pdfReceipts',
    label: 'Instant Downloadable PDF Receipts',
    tier: 'core',
    module: 'payments',
    description: 'Generate and download PDF receipts for payments instantly.',
  },

  // Existing per-school feature flags (storage-compatible)
  installments: {
    id: 'installments',
    label: 'Installments',
    tier: 'core',
    module: 'plans',
    description: 'Enable installment plan functionality.',
  },
  idCards: {
    id: 'idCards',
    label: 'ID Cards',
    tier: 'core',
    module: 'records',
    description: 'Enable ID card generation and printing.',
  },
  whatsapp: {
    id: 'whatsapp',
    label: 'WhatsApp Integration',
    tier: 'core',
    module: 'outreach',
    description: 'Enable WhatsApp messaging and support.',
  },
  apiAccess: {
    id: 'apiAccess',
    label: 'API Access',
    tier: 'core',
    module: 'academics',
    description: 'Enable SIS/ERP API integration.',
  },

  lmsBasic: {
    id: 'lmsBasic',
    label: 'Lesson Library & Basic Assignments',
    tier: 'starter',
    module: 'academics',
    description: 'Upload lessons and distribute basic assignments to students.',
  },

  lmsQuizzes: {
    id: 'lmsQuizzes',
    label: 'Quizzes & Grading',
    tier: 'growth',
    module: 'academics',
    description: 'Create quizzes and grade student submissions.',
  },

  lmsAnalytics: {
    id: 'lmsAnalytics',
    label: 'Basic LMS Analytics',
    tier: 'growth',
    module: 'insight',
    description: 'View basic student performance analytics and progress reports.',
  },

  lmsAdvanced: {
    id: 'lmsAdvanced',
    label: 'Multi-Campus Content & API',
    tier: 'campus',
    module: 'academics',
    description: 'Share content across campuses and integrate via SIS/ERP APIs.',
  },

  // Growth tier extras (beyond Starter core)
  installmentPlans: {
    id: 'installmentPlans',
    label: 'Structured Installment Plans (2–6 tranches)',
    tier: 'growth',
    module: 'plans',
    description: 'Allow parents to split payments into multiple installments.',
  },

  arrearsDashboard: {
    id: 'arrearsDashboard',
    label: 'Installment Compliance & Arrears Dashboard',
    tier: 'growth',
    module: 'insight',
    description: 'Track overdue installment plans and compliance.',
  },

  cashFlowAnalytics: {
    id: 'cashFlowAnalytics',
    label: 'Cash Flow Forecasting & Velocity Analytics',
    tier: 'growth',
    module: 'insight',
    description: 'Forecast cash flow and analyze payment velocity.',
  },

  // Campus tier extras (beyond Growth core)
  multiCampusControls: {
    id: 'multiCampusControls',
    label: 'Multi-Campus & Multi-Signatory Financial Controls',
    tier: 'campus',
    module: 'administration',
    description: 'Control finances across multiple campuses with multi-signature approvals.',
  },

  customAuditReports: {
    id: 'customAuditReports',
    label: 'Custom Audit Reports & MoE Compliance Exports',
    tier: 'campus',
    module: 'insight',
    description: 'Generate custom audit reports and Ministry of Education compliance exports.',
  },

  successAccountManager: {
    id: 'successAccountManager',
    label: 'Dedicated School Success Account Manager',
    tier: 'campus',
    module: 'administration',
    description: 'Assigned account manager for dedicated support and optimization.',
  },

  erpIntegration: {
    id: 'erpIntegration',
    label: 'SIS & School ERP API Integration',
    tier: 'campus',
    module: 'academics',
    description: 'Integrate with Student Information System and School ERP via APIs.',
  },

  customSenderId: {
    id: 'customSenderId',
    label: 'Custom SMS Sender ID Branding',
    tier: 'campus',
    module: 'outreach',
    description: 'Brand SMS messages with custom sender IDs (e.g., ACHIMOTA-SCH).',
  },
};

/**
 * Tier definitions — mapping server plan values to marketing tiers and feature inheritance.
 */
export const TIERS = {
  free: {
    marketing: 'Free',
    server: ['trial', 'free'],
    inheritance: null, // base tier
    features: [
      // Core (inherited)
      FEATURES.bulkStudentUpload.id,
      FEATURES.momoPayments.id,
      FEATURES.smsReminders.id,
      FEATURES.pdfReceipts.id,
    ],
  },
  starter: {
    marketing: 'Starter',
    server: ['starter'],
    inheritance: 'free',
    features: [
      ...TIERS.free.features,
      // Starter-specific (LMS)
      FEATURES.lmsBasic.id,
    ],
  },
  growth: {
    marketing: 'Growth',
    server: ['growth'],
    inheritance: 'starter',
    features: [
      ...TIERS.starter.features,
      // Growth-specific
      FEATURES.installmentPlans.id,
      FEATURES.arrearsDashboard.id,
      FEATURES.cashFlowAnalytics.id,
      // Growth LMS
      FEATURES.lmsQuizzes.id,
      FEATURES.lmsAnalytics.id,
    ],
  },
};

/**
 * Tier ranking for ordering and inheritance resolution.
 */
export const TIER_RANK = ['starter', 'growth', 'campus'];

/**
 * Returns the tier key for a school (e.g., 'starter', 'growth', 'campus').
 *
 * @param {object} school - School document (must have subscription.plan)
 * @returns {string | null} Tier key
 */
export const getTierForSchool = (school) => {
  if (!school?.subscription?.plan) return null;

  // Normalize first: a legacy or status-suffixed plan (e.g. `"premiumactive"`)
  // resolves to its surviving tier so the school keeps its entitlements.
  const plan = normalizePlan(school.subscription.plan);

  for (const tierKey of TIER_RANK) {
    if (TIERS[tierKey].server.includes(plan)) {
      return tierKey;
    }
  }
  return null;
};

/**
 * Returns all enabled feature IDs for a school.
 *
 * Features are enabled if they belong to the school's tier or any higher tier.
 * This includes features from the subscription tier and any per-school featureFlags.
 *
 * @param {object} school - School document (must have subscription.plan and subscription.featureFlags)
 * @returns {Set<string>} Feature IDs enabled for this school
 */
export const resolveEntitlements = (school) => {
  const tierKey = getTierForSchool(school);
  if (!tierKey) return new Set();

  // Start with tier features
  const enabled = new Set(TIERS[tierKey].features);

  // Add any per-school featureFlags that are enabled (e.g., from platform settings)
  // Note: Existing featureFlags are: installments, idCards, whatsapp, apiAccess
  if (school.subscription?.featureFlags) {
    const flags = school.subscription.featureFlags;
    if (flags.installments) enabled.add(FEATURES.installments.id);
    if (flags.idCards) enabled.add(FEATURES.idCards.id);
    if (flags.whatsapp) enabled.add(FEATURES.whatsapp.id);
    if (flags.apiAccess) enabled.add(FEATURES.apiAccess.id);
  }

  return enabled;
};

/**
 * Whether a school is entitled to a specific feature.
 *
 * @param {object} school - School document
 * @param {string} featureId - Feature ID (e.g., FEATURES.lmsAnalytics.id)
 * @returns {boolean}
 */
export const hasFeature = (school, featureId) => {
  const enabled = resolveEntitlements(school);
  return enabled.has(featureId);
};

/**
 * Lists all features that a school is not entitled to (upgrade targets).
 *
 * @param {object} school - School document
 * @param {string} tierKey - Tier key to list locked features for (defaults to current tier)
 * @returns {Array<object>} Features with tier and locked status
 */
export const lockedFeaturesForTier = (school, tierKey = getTierForSchool(school)) => {
  if (!tierKey) return [];

  // Get the next tier's features
  const currentIndex = TIER_RANK.indexOf(tierKey);
  if (currentIndex < TIER_RANK.length - 1) {
    const nextTierKey = TIER_RANK[currentIndex + 1];
    const nextTierFeatures = TIERS[nextTierKey].features;

    // Identify which next tier features are not in current tier
    const currentFeatures = TIERS[tierKey].features;
    return nextTierFeatures
      .filter((fid) => !currentFeatures.includes(fid))
      .map((fid) => ({ featureId: fid, feature: FEATURES[fid] }));
  }
  return []; // Campus is the top tier
};