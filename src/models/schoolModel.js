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
      hubtelClientId: {
        type: String,
        select: false,
        default: null,
      },
      hubtelClientSecret: {
        type: String,
        select: false,
        default: null,
      },
      hubtelApiKey: {
        type: String,
        select: false,
        default: null,
      },
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
        enum: ["hubtel", "arke", "mnotify", "manual"],
        default: "hubtel",
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
        enum: ["hubtel", "arke", "mnotify"],
        // Arkesel is the primary gateway. A school that has chosen a different
        // provider keeps it; this only governs schools that never set one.
        default: "arke",
      },
      senderId: { type: String, default: "" },
      apiKey: { type: String, select: false, default: null },
      balance: { type: Number, default: 0 },
    },
    subscription: {
      plan: {
        type: String,
        enum: ["trial", "basic", "standard", "premium", "enterprise"],
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
    },
    academic: {
      currentTerm: { type: String, default: "" },
      currentYear: { type: String, default: new Date().getFullYear().toString() },
      termsPerYear: { type: Number, default: 3, min: 1, max: 4 },
      classes: [{ type: String, trim: true }],
      gradingSystem: {
        type: String,
        enum: ["WAEC", "IB", "Cambridge", "Custom"],
        default: "WAEC",
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

schoolModel.set("toJSON", {
  virtuals: true,
  transform: (_doc, ret) => {
    if (ret.payment) {
      delete ret.payment.hubtelApiKey;
      delete ret.payment.hubtelClientSecret;
    }
    if (ret.sms) {
      delete ret.sms.apiKey;
    }
    delete ret.__v;
    return ret;
  },
});

export const School = mongoose.model("School", schoolModel);