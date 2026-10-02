import mongoose from "mongoose";

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
      trialDays: { type: Number, default: 30, min: 0, max: 365 },
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
  features: { adsEnabled: true, selfSignupEnabled: true, trialDays: 30 },
  maintenance: { mode: "off", message: "" },
};

export const PlatformSettings = mongoose.model(
  "PlatformSettings",
  platformSettingsSchema
);

export default PlatformSettings;