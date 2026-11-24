import mongoose from "mongoose";

const schoolModel = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 150,
    },
    slug: {
      type: String,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    schoolCode: {
      type: String,
      unique: true,
      uppercase: true,
      trim: true,
      index: true,
    },
    type: {
      type: String,
      enum: ["public", "private", "international", "mission", "charter"],
      required: true,
    },
    motto: {
      type: String,
      trim: true,
      maxlength: 200,
      default: "",
    },
    yearFounded: {
      type: Number,
      min: 1800,
      max: new Date().getFullYear(),
    },
    phone: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },
    website: {
      type: String,
      trim: true,
      default: "",
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    city: {
      type: String,
      required: true,
      trim: true,
    },
    region: {
      type: String,
      required: true,
      enum: [
        "Ahafo",
        "Ashanti",
        "Bono",
        "Bono East",
        "Central",
        "Eastern",
        "Greater Accra",
        "North East",
        "Northern",
        "Oti",
        "Savannah",
        "Upper East",
        "Upper West",
        "Volta",
        "Western",
        "Western North",
      ],
    },
    gpsAddress: {
      type: String,
      trim: true,
      default: "",
    },
    /**
     * Coordinates for the school gate.
     *
     * Separate from `gpsAddress` on purpose. The digital address is the legally
     * meaningful identifier and is what Ghana Post and couriers quote; lat/lng is
     * what a map can render and what a "near me" sort can use. Storing one
     * without the other is normal — plenty of schools know their digital address
     * and not their coordinates — so neither is required and neither is derived
     * from the other automatically.
     *
     * `source` records how the pin was set, which is the difference between a
     * dropper that put the marker on the school's gate and one that put it at
     * the district centroid. Showing a wrong pin as authoritative is the failure
     * mode worth avoiding.
     */
    location: {
      latitude: { type: Number, default: null, min: -90, max: 90 },
      longitude: { type: Number, default: null, min: -180, max: 180 },
      source: {
        type: String,
        enum: ["gps_address", "map_pin", "device", "manual", null],
        default: null,
      },
      updatedAt: { type: Date, default: null },
    },
    logo: {
      type: String,
      default: null,
    },
    stamp: {
      type: String,
      default: null,
    },
    brandColor: {
      type: String,
      default: "#1E3A8A",
      trim: true,
    },
    payment: {
      momoMerchantId: {
        type: String,
        default: null,
      },
      bankAccount: {
        accountName: { type: String, default: "" },
        accountNumber: { type: String, default: "" },
        bankName: { type: String, default: "" },
        branch: { type: String, default: "" },
      },
      gatewayMode: {
        type: String,
        enum: ["moolre", "arke", "mnotify", "manual"],
        default: "moolre",
      },
      platformMarkupPercent: {
        type: Number,
        default: 0,
        min: 0,
        max: 100,
      },
      networksEnabled: {
        mtn: { type: Boolean, default: true },
        telecel: { type: Boolean, default: true },
        airteltigo: { type: Boolean, default: true },
      },
    },
    sms: {
      provider: {
        type: String,
        enum: ["moolre", "arke", "mnotify"],
        // Moolre is the primary gateway: it collects the payments and carries
        // the SMS on the same wallet. A school that has chosen a different
        // provider keeps it; this only governs schools that never set one.
        default: "moolre",
      },
      senderId: { type: String, default: "" },
      apiKey: { type: String, select: false, default: null },
      balance: { type: Number, default: 0 },
    },
    subscription: {
      plan: {
        type: String,
        enum: ["trial", "free", "starter", "growth", "campus", "basic", "standard", "premium", "enterprise"],
        default: "trial",
      },
      status: {
        type: String,
        enum: ["active", "suspended", "expired", "cancelled", "trial"],
        default: "trial",
      },
      trialEndsAt: { type: Date, default: null },
      currentPeriodStart: { type: Date, default: null },
      currentPeriodEnd: { type: Date, default: null },
      cancelledAt: { type: Date, default: null },
      paymentMethod: {
        type: String,
        enum: ["momo", "card", "bank_transfer", "manual"],
        default: "momo",
      },
      monthlyFee: {
        type: Number,
        default: 0,
        min: 0,
      },
      paymentStatus: {
        type: String,
        enum: ["none", "pending", "completed"],
        default: "none",
      },
    },

    /**
     * Platform fee charged on top of a school's own gateway (Mode B).
     *
     * Separate from `payment.platformMarkupPercent` because the two are charged on
     * different things at different moments: markup is skimmed from each parent
     * payment as it arrives, while a platform fee is what a school running its own
     * gateway account owes SukuuPay for using SukuuPay to talk to those parents.
     * Conflating them would make one school's gateway choice change its per-payment
     * rate.
     *
     * Zero for most schools and non-zero for Mode B only, which is why it defaults
     * to `0` rather than to the platform default — an unset platform fee is "we are
     * not charging you", and that is the state a school must never be put into by
     * accident when a new field lands.
     *
     * **Top level, not inside `subscription`.** Everything below this comment is
     * platform-set, and putting it under `subscription` would make it read as part
     * of what the *school* bought — a fee the school chose, adjustable by the school's
     * own admin through any endpoint that writes the subscription wholesale.
     */
    platformFeePercent: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    /**
     * Per-school capability switches, set by the platform.
     *
     * Not `PlatformSettings.features` and not the same thing: those are global
     * ("self-signup is off for everyone"), these are per-tenant ("this school has no
     * API access"). The distinction matters because support turns one of these on for
     * a single paying school during an integration, and must be able to do it without
     * a redeploy and without touching anybody else's account.
     *
     * Each defaults the way the product already behaves, so an existing school gains
     * no new capability the day this field appears. `whatsapp` and `apiAccess`
     * default **false** because those two cost real money per conversation and per
     * call; a tenant must be opted in, never in by omission.
     */
     featureFlags: {
      installments: { type: Boolean, default: true },
      idCards: { type: Boolean, default: true },
      whatsapp: { type: Boolean, default: false },
      apiAccess: { type: Boolean, default: false },
    },

    /**
     * Per-school ID card configuration.
     * Stored here so a school can pick its layout, sides, and field visibility
     * without every batch document carrying these values. Batches snapshot the
     * resolved settings at creation time so reprints remain stable.
     */
    settings: {
      idCards: {
        sheetLayout: {
          type: String,
          enum: ["6up_a4_landscape", "9up_a4_landscape"],
          default: "6up_a4_landscape",
        },
        sides: {
          type: String,
          enum: ["front_back", "front"],
          default: "front_back",
        },
        showQr: { type: Boolean, default: true },
        showPhoto: { type: Boolean, default: true },
        showStamp: { type: Boolean, default: true },
        includeCutGuides: { type: Boolean, default: false },
      },
    },

    /**
     * Notes only the platform can see.
     *
     * Not a `School` field a school admin may ever write, and not surfaced by any
     * school-scoped response: this is the account manager's column for "chased twice
     * about the December outage", "owner is his aunt's school, invoices to the
     * personal number". A school reading a note that says *this customer is a pain to
     * collect from* is a relationship the platform does not get to have.
     */
    internalNotes: {
      type: String,
      trim: true,
      maxlength: 2000,
      default: "",
    },

    /**
     * The platform user who looks after this school.
     *
     * Nullable on purpose: the platform has one `super_admin` today, and pointing
     * every school at that account would make the field a constant rather than an
     * assignment. It exists so the field means something the moment there is a second
     * one — "my schools" is a view this console can then offer.
     */
    accountManagerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    /**
     * When this school finished onboarding — first real student imported, first
     * payment taken, whatever the school defines as done.
     *
     * A single stamp rather than a checklist because the only question the console
     * asks is "how long did this take", which is exactly what a per-milestone set of
     * dates would be averaged into. Set once by the payment/import paths and never
     * rewritten, so it measures activation rather than recency of activity.
     *
     * **No `index: true` here** — indexed once in the `schoolModel.index()` block
     * below, beside the activation-reporting comment that explains why. Declaring both
     * makes Mongoose warn about a duplicate and keep the first, so this bare flag
     * would win and the declared index would be dead.
     */
    onboardingCompletedAt: {
      type: Date,
      default: null,
    },

    /**
     * Free-form operator labels: "pilot", "enterprise", "at-risk".
     *
     * Arrays of strings rather than a fixed enum because the set that turns out to be
     * useful is discovered in practice, not in advance, and an enum here would be a
     * migration every time someone invents a word. Free text is filtered by
     * `GET /admin/schools?tag=`, so a typo simply matches nothing — the cost of
     * flexibility is a tag that quietly matches no rows, which is a far better
     * failure than a schema that cannot express the label at all.
     */
    tags: {
      type: [String],
      default: [],
      index: true,
    },

    /**
     * Verification & KYB fields
     *
     * Tier 0 = UNVERIFIED (manual entry, no directory match)
     * Tier 1 = DIRECTORY_MATCHED (soft-verified via Ghana schools directory)
     * Tier 2 = VERIFIED (full KYB document review passed)
     */
    verificationStatus: {
      type: String,
      enum: ["UNVERIFIED", "DIRECTORY_MATCHED", "PENDING_REVIEW", "VERIFIED", "REJECTED"],
      default: "UNVERIFIED",
      index: true,
    },
    verificationTier: {
      type: Number,
      enum: [0, 1, 2],
      default: 0,
      index: true,
    },
    emisCode: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    nasiaRegistrationNumber: {
      type: String,
      trim: true,
      sparse: true,
      unique: true,
    },
    externalDirectorySource: {
      type: String,
      enum: ["sukuudata", "ghana_api", "manual", null],
      default: null,
      index: true,
    },
    externalDirectoryId: {
      type: String,
      trim: true,
      default: null,
    },
    region: {
      type: String,
      required: true,
      enum: [
        "Ahafo",
        "Ashanti",
        "Bono",
        "Bono East",
        "Central",
        "Eastern",
        "Greater Accra",
        "North East",
        "Northern",
        "Oti",
        "Savannah",
        "Upper East",
        "Upper West",
        "Volta",
        "Western",
        "Western North",
      ],
    },
    district: {
      type: String,
      trim: true,
      default: "",
    },
    schoolLevel: {
      type: String,
      enum: ["Basic/Primary", "JHS", "SHS/SHTS", "TVET", "International"],
      default: "Basic/Primary",
    },
    schoolOwnership: {
      type: String,
      enum: ["Public", "Private"],
      default: "Private",
    },
    kybDocuments: [
      {
        type: {
          type: String,
          enum: ["NASIA_LICENSE", "RGD_CERTIFICATE", "AUTHORIZATION_LETTER", "HEADTEACHER_ID"],
          required: true,
        },
        fileUrl: {
          type: String,
          required: true,
        },
        uploadedAt: {
          type: Date,
          default: Date.now,
        },
        reviewStatus: {
          type: String,
          enum: ["PENDING", "APPROVED", "REJECTED"],
          default: "PENDING",
        },
        reviewNote: {
          type: String,
          trim: true,
          default: "",
        },
        reviewedAt: {
          type: Date,
          default: null,
        },
        reviewedBy: {
          type: mongoose.Schema.Types.ObjectId,
          ref: "User",
          default: null,
        },
      },
    ],
    rejectionReason: {
      type: String,
      trim: true,
      default: "",
    },
    verifiedAt: {
      type: Date,
      default: null,
    },
    verifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    academic: {
      currentTerm: { type: String, default: "" },
      currentYear: { type: String, default: new Date().getFullYear().toString() },
      termsPerYear: { type: Number, default: 3, min: 1, max: 4 },
      classes: [{ type: String, trim: true }],
      /**
       * The classes a student may graduate from, when the school is not shaped
       * like the last-three assumption.
       *
       * `getFinalYearClassesFrom` falls back to `classes.slice(-3)`, which is
       * right for a school running JHS 1–3 and wrong for every other shape. A
       * Ghanaian basic-and-JHS school listing `Nursery 1 … Primary 6, JHS 1–3`
       * has its last three as JHS 1–3, so a JHS 1 student passed
       * `graduateStudent`'s "not in a final year class" guard — the guard was
       * protecting nothing. Naming the final years explicitly is what makes both
       * graduation and the cohort data correct, and it is one field rather than
       * the `Class` collection the module spec proposes.
       *
       * Empty means "use the fallback", so a school that has not set it behaves
       * exactly as before.
       */
      finalYearClasses: [{ type: String, trim: true }],
      gradingSystem: {
        type: String,
        enum: ["WAEC", "IB", "Cambridge", "Custom"],
        default: "WAEC",
      },
      /**
       * The school's grading policy: how the terminal report is weighted.
       *
       * The 30/70 split — class assessment 30%, end-of-term exam 70% — is
       * the Ghanaian standard and the default. It lives here rather than in
       * the arithmetic because it is a *policy*: a private school on a
       * Cambridge-style curriculum runs 40/60, and a school that does not
       * run a group project has no group-work column to weight.
       *
       * `components` is the class assessment's breakdown — the parts that make
       * up the 30 points, and how many of the 30 each one is worth. The
       * default is the common split: class test 9, group work 9, homework 6,
       * class work 6. Each part is marked on its own maximum, which is the
       * default here and recorded on the grade row when it is entered.
       *
       * Read through `utils/gradingConfig.js`, which fills in the defaults for
       * a school that has never set any of this, so a missing field is a
       * working policy and not a broken page.
       */
      grading: {
        classWeight: { type: Number, default: 30, min: 0, max: 100 },
        examWeight: { type: Number, default: 70, min: 0, max: 100 },
        components: {
          type: [
            {
              key: { type: String, required: true, trim: true },
              label: { type: String, required: true, trim: true },
              weight: { type: Number, required: true, min: 0 },
              maxScore: { type: Number, default: 100, min: 1 },
            },
          ],
          default: () => [
            { key: "class_test", label: "Class Test", weight: 9, maxScore: 30 },
            { key: "group_work", label: "Group Work", weight: 9, maxScore: 30 },
            { key: "homework", label: "Homework", weight: 6, maxScore: 20 },
            { key: "class_work", label: "Class Work", weight: 6, maxScore: 20 },
          ],
        },
      },
    },
    notifications: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      inApp: { type: Boolean, default: true },
      // Governs outbound WhatsApp only. Inbound messages are still recorded —
      // a parent who replies must never be told their message vanished.
      whatsapp: { type: Boolean, default: true },
    },
    status: {
      type: String,
      enum: ["active", "suspended", "archived"],
      default: "active",
      index: true,
    },
    suspendedReason: {
      type: String,
      trim: true,
      default: "",
    },
    suspendedAt: {
      type: Date,
      default: null,
    },
    stats: {
      totalStudents: { type: Number, default: 0 },
      totalTeachers: { type: Number, default: 0 },
      totalParents: { type: Number, default: 0 },
      totalPaymentsThisMonth: { type: Number, default: 0 },
    },
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    deletedAt: {
      type: Date,
      default: null,
      index: true,
    },
  },
  { timestamps: true }
);

schoolModel.index({ status: 1, region: 1 });

/*
 * The platform console's list and filter reads.
 *
 * `{ status, subscription.status }` is the "who can I actually bill" question,
 * which `GET /admin/schools` answers but neither of the two single-field indexes
 * above can. `{ tags, status }` is the same list filtered by an operator label,
 * and `tags` is multikey — so it may not be combined with another array field, and
 * this is the only compound that uses it.
 *
 * `onboardingCompletedAt` is indexed on its own for activation reporting: schools
 * that signed up and never onboarded are found by "completed before X", which is a
 * scan without it.
 */
schoolModel.index({ status: 1, "subscription.status": 1 });
schoolModel.index({ tags: 1, status: 1 });
schoolModel.index({ onboardingCompletedAt: 1 });
schoolModel.index({ verificationStatus: 1, verificationTier: 1 });
schoolModel.index({ externalDirectorySource: 1, externalDirectoryId: 1 });
schoolModel.index({ region: 1, district: 1 });

schoolModel.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    if (ret.sms) {
      delete ret.sms.apiKey;
    }
    delete ret.__v;
    return ret;
  },
});

export const School = mongoose.model("School", schoolModel);