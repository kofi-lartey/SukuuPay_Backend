import mongoose from "mongoose";
import {
  SHEET_LAYOUT_NAMES,
  DEFAULT_SHEET_LAYOUT,
} from "../utils/idCardSheet.js";

/**
 * Platform-wide settings: **one document, ever.**
 *
 * There is no school here and no per-tenant variation — this is the configuration
 * of SukuuPay itself, which is why it is a singleton rather than another field on
 * `School`. A platform operator needs three things the product could not express
 * anywhere:
 *
 *   - `defaultMarkupPercent` — what a *new* school is set to. Existing schools
 *     carry their own `payment.platformMarkupPercent`, which is what the revenue
 *     aggregations read (`admin.service.js`), so this default never rewrites a
 *     live school's rate.
 *   - `features` — self-signup and the public ad slider are currently hard-coded.
 *     Turning either off has to be possible without a redeploy.
 *   - `maintenance` — a read-only state for the whole platform during a migration.
 *     There is no other way to take SukuuPay quiet.
 *
 * **The singleton is enforced by a unique index on a constant field**, not by
 * convention. `singletonKey` is always the string `"platform"`, and
 * `unique: true` means a second insert fails with E11000 rather than quietly
 * creating a rival configuration — which is the same reason `User.email` is
 * unique: a rule that is only written down is a rule that gets violated the first
 * time somebody adds a code path.
 *
 * Read with a plain `findOne()` and defaulted in code rather than upserted on
 * read. A GET that writes is a GET with a side effect, it needs write
 * permissions to work, and two concurrent first-requests would race the unique
 * index. The document is created by the first PUT.
 */
const platformSettingsSchema = new mongoose.Schema(
  {
    // Always `"platform"`. Exists solely to carry the unique index that makes
    // "one document, ever" true in the database rather than in a comment.
    singletonKey: {
      type: String,
      default: "platform",
      enum: ["platform"],
      unique: true,
      immutable: true,
    },

    /**
     * What a newly provisioned school is given.
     *
     * A percentage, matching `School.payment.platformMarkupPercent`, and applied as
     * `amount / 100 * percent` everywhere revenue is aggregated. Stored as a number
     * rather than a fraction because the per-school field is a percentage and two
     * conventions for one quantity is how a markup silently becomes 100× itself.
     */
    defaultMarkupPercent: {
      type: Number,
      default: 5,
      min: 0,
      max: 100,
    },

    features: {
      /** Whether the public creative slider is served at all. */
      adsEnabled: { type: Boolean, default: true },
      /** Whether a new account can be created without an invitation. */
      selfSignupEnabled: { type: Boolean, default: true },
      /** How long a new school stays on trial. */
      trialDays: { type: Number, default: 7, min: 0, max: 365 },
    },

    /**
     * What a Mode B school is billed for using SukuuPay.
     *
     * Charged per month on the school's own gateway volume, never taken from a
     * parent payment — which is why it is a separate field and not a second markup.
     * See `School.platformFeePercent`, which carries the per-school value; this one
     * only decides what a *new* school gets.
     *
     * Capped at 5% where `defaultMarkupPercent` allows 100. A percentage of a
     * school's own collected volume is a much larger number of cedis than the same
     * percentage skimmed off one payment, and a 100% default here would bill a
     * tenant everything they collect. The cap is the guard against a typo that
     * looks like a valid value.
     */
    defaultPlatformFeePercent: {
      type: Number,
      default: 0.5,
      min: 0,
      max: 5,
    },

    /**
     * The monthly subscription a new paid school starts on.
     *
     * In **pesewas**, like every other money field: 15000 is GHS 150.0, not GHS
     * 15,000. A cedi-denominated field sitting among integer pesewas fields is the
     * single easiest place in this schema to be off by 100, and the error is
     * invisible until a school is invoiced.
     */
    defaultMonthlyFee: {
      type: Number,
      default: 15000,
      min: 0,
    },

    /**
     * How schools get paid, and whether a person signs it off.
     *
     * Grouped rather than three top-level fields because they are one decision:
     * when a payout runs, and who may let it. Splitting them invites a
     * configuration with a frequency and no day, which cannot be scheduled at all.
     *
     * `autoApprove` defaults **false**, and that default is the product's most
     * consequential value in this file. It is the difference between a payout run
     * needing one human click and money leaving the platform unattended; turning it
     * on is an explicit act by the owner, recorded in `updatedBy` and in the audit
     * trail, and it is never inherited from a previous setting.
     */
    disbursement: {
      frequency: {
        type: String,
        enum: ["daily", "weekly", "biweekly", "monthly"],
        default: "weekly",
      },
      /**
       * 0 = Sunday … 6 = Saturday, matching JavaScript's `Date#getDay`.
       *
       * That index, not 1–7, because it is what `cron` and `Date#getDay` both use,
       * so a schedule written here needs no off-by-one translation at the one place
       * it is consumed. Default 1 = Monday, which is when Ghanaian schools close
       * their books for the week.
       */
      dayOfWeek: { type: Number, default: 1, min: 0, max: 6 },
      autoApprove: { type: Boolean, default: false },
    },

    /**
     * The platform's own SMS configuration.
     *
     * Distinct from `School.sms`, which is a tenant's gateway and key. The platform
     * sends its own messages — payment receipts, payout confirmations, maintenance
     * notices to school admins — and those come out of one master account, so the
     * rate and provider have to be configurable in one place rather than summed
     * across every school's own balance.
     *
     * `ratePesewas` is the cost of one SMS in pesewas and is the number both the
     * cost-to-date figure and the "estimated cost" in any composer are computed
     * from. It defaults to 25 (GHS 0.25) rather than to the existing per-school
     * `SMS_CREDIT_RATE_PES`, because a platform-wide broadcast is priced
     * differently from a school's reminder to its own parents.
     */
    sms: {
      provider: {
        type: String,
        // Arkesel is the primary gateway everywhere else in the product; Moolre
        // is here because it carries SMS on the same wallet it collects on, so
        // a platform that has switched to Moolre for payments has a way to
        // switch its own messages over without a deploy.
        enum: ["arke", "moolre"],
        default: "arke",
      },
      ratePesewas: { type: Number, default: 25, min: 0 },

      /**
       * At what remaining balance the console warns.
       *
       * A plain number rather than a boolean because the useful question is not "is
       * the pool empty" but "is there enough left to serve a normal school", and one
       * school's purchase can be 200 units where the next is 20,000. Default is zero,
       * which means "only warn at empty" — the behaviour before this setting existed —
       * so a deployment that has never been configured is not suddenly noisy.
       */
      poolLowThreshold: { type: Number, default: 0, min: 0 },
    },

    /**
     * How ID-card batches are printed.
     *
     * Configuration rather than a constant because it is a printing decision a school
     * makes about its own stock: 5-up is one straight guillotine cut five times down a
     * sheet, 8-up is the denser conventional layout for printing hundreds. Neither is
     * better, and changing it should not need a redeploy.
     *
     * `sheetLayout` is validated against the generator's own names rather than restated,
     * so a renamed layout cannot be left behind here as a value the generator rejects.
     */
    idCards: {
      sheetLayout: {
        type: String,
        enum: SHEET_LAYOUT_NAMES,
        default: DEFAULT_SHEET_LAYOUT,
      },
      sides: {
        type: String,
        enum: ["front_back", "front_only"],
        default: "front_back",
      },
      /**
       * Whether a school may generate a batch at all.
       *
       * Defaults **false**. Card generation produces a printable artefact and consumes
       * a QR-code render per student, so "on by default for every school" is a feature
       * flag that ships switched on and never reviewed. An operator turns it on.
       */
      enabled: { type: Boolean, default: false },
    },

    /**
     * Who a school is told to contact.
     *
     * Rendered into emails, SMS and the public site's footer, so it is
     * configuration rather than a constant: a support number that changes has to be
     * changeable by the owner, in the console, without a redeploy.
     */
    support: {
      phone: { type: String, trim: true, default: "" },
      email: { type: String, trim: true, lowercase: true, default: "" },
    },

    maintenance: {
      /**
       * `off` | `readonly` | `on`.
       *
       * Three states rather than two, because "the platform is down" and "the
       * platform is up but nobody may change anything" are different situations and
       * an operator in the middle of a migration needs the second one. `readonly`
       * keeps every read open and refuses every write, which is the state that
       * makes a schema migration safe to run.
       */
      mode: {
        type: String,
        enum: ["off", "readonly", "on"],
        default: "off",
      },
      /** Shown to users while `mode !== "off"`. Empty means "say nothing". */
      message: { type: String, default: "", maxlength: 500 },
    },

    /**
     * Which payment gateways are active at the platform level.
     *
     * `activeGateways` is the source of truth for the gate-level switch that
     * `resolveGateway` reads: only entries with `active: true` are ever selected,
     * and the remaining providers stay in the school enum so existing school
     * configs are not invalidated by a code change. Moolre is the active
     * gateway; Arke, Mnotify, MTN and the manual rail are retained but disabled.
     */
    payment: {
      activeGateways: {
        type: [String],
        enum: ["moolre", "arke", "mnotify", "mtn", "manual"],
        default: ["moolre"],
      },
    },

    /**
     * Who last wrote this.
     *
     * A reference, not a copy, because a platform setting is exactly the kind of
     * change that gets disputed later ("who set the markup to 12?") and an id is
     * only useful if it still resolves.
     */
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
  },
  { timestamps: true }
);

/**
 * The values a settings document falls back to.
 *
 * Exported so `getPlatformSettings` and the schema's defaults cannot drift: a
 * default written in two places is a default that will be changed in one of them,
 * and the first GET after that reports a setting nobody can find in the code.
 */
export const DEFAULT_PLATFORM_SETTINGS = {
  singletonKey: "platform",
  defaultMarkupPercent: 5,
  defaultPlatformFeePercent: 0.5,
  defaultMonthlyFee: 15000,
  features: { adsEnabled: true, selfSignupEnabled: true, trialDays: 7 },
  disbursement: { frequency: "weekly", dayOfWeek: 1, autoApprove: false },
  sms: { provider: "arke", ratePesewas: 25, poolLowThreshold: 0 },
  idCards: {
    sheetLayout: DEFAULT_SHEET_LAYOUT,
    sides: "front_back",
    enabled: false,
  },
  support: { phone: "", email: "" },
  maintenance: { mode: "off", message: "" },
  payment: { activeGateways: ["moolre"] },
};

/**
 * The nested branches that must be merged field-by-field rather than spread.
 *
 * Read down `getPlatformSettings` (`admin.service.js`) and
 * `getCachedPlatformSettings` (`platformSettings.service.js`) — both merge these
 * by name, and both were written before `disbursement`, `sms` and `support`
 * existed. A branch missing here is replaced wholesale by a partial stored
 * document, so a school-provisioning write that stored `sms` without `ratePesewas`
 * would leave the rate `undefined` and every cost figure computed as `NaN`.
 */
export const NESTED_PLATFORM_SETTINGS_BRANCHES = [
  "features",
  "disbursement",
  "sms",
  "idCards",
  "support",
  "maintenance",
  "payment",
];

export const PlatformSettings = mongoose.model(
  "PlatformSettings",
  platformSettingsSchema
);

export default PlatformSettings;