import mongoose from "mongoose";
import { Payment } from "../models/paymentModel.js";
import { Student } from "../models/studentModel.js";
import { School } from "../models/schoolModel.js";
import { Counter } from "../models/counterModel.js";
import { ApiError } from "./student.service.js";
import * as auditService from "../utils/auditService.js";

/**
 * Record a payment taken at the bursar's desk.
 *
 * Cash, a cheque, a bank transfer into the school's account — the money that
 * never touches a Mobile Money prompt but is real, and has to land in the same
 * ledger as everything else or the school's collected figure is wrong. There was
 * no endpoint for it at all, so the dashboard's "Record Manual Payment" button
 * had nothing to call.
 *
 * The mechanics that make this more than a wrapper around `Payment.create`:
 *
 * - **It settles the student.** `Student.totalPaid` and `balance` are
 *   denormalised onto the record, and the roster, the KPI band and every report
 *   read them. A payment row that does not also move the student's balance is a
 *   payment the school cannot see.
 * - **It is transactional.** A recorded payment with an unchanged balance is the
 *   exact failure a bursar cannot detect by looking at the student, because the
 *   payment is in the list and the balance is unchanged. Both or neither.
 * - **It cannot overpay silently.** An amount beyond the balance is refused
 *   unless `allowOverpayment` is set, because a balance that flips negative
 *   turns every "owes money" figure in the product into a credit nobody
 *   explained.
 * - **`settlement.appliedAt` is set.** The provider webhook that normally
 *   claims a settlement checks it first, so a later callback for a
 *   provider-invented reference is a no-op rather than a second credit.
 *
 * Amounts are integer pesewas, like every other money field in this API.
 */
export const recordManualPayment = async (body, user) => {
  const {
    studentRef,
    amount,
    method = "cash",
    reference = null,
    notes = null,
    receivedAt = null,
    allowOverpayment = false,
  } = body;

  if (!studentRef) {
    throw new ApiError("A student is required", 400, "STUDENT_REQUIRED");
  }
  if (!Number.isInteger(amount) || amount <= 0) {
    throw new ApiError(
      "Amount must be a positive whole number of pesewas",
      400,
      "INVALID_AMOUNT"
    );
  }
  if (!["cash", "card", "bank_transfer"].includes(method)) {
    // `momo` is excluded on purpose: a Mobile Money payment has a provider
    // callback that confirms it, and a manual "momo" row would be a second,
    // unauthenticated claim on money the gateway may also report.
    throw new ApiError(
      "Method must be cash, card or bank_transfer",
      400,
      "INVALID_METHOD"
    );
  }

  const session = await Payment.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      const isObjectId = mongoose.Types.ObjectId.isValid(studentRef);
      const student = await Student.findOne({
        ...(isObjectId
          ? { $or: [{ studentId: String(studentRef).toUpperCase() }, { _id: studentRef }] }
          : { studentId: String(studentRef).toUpperCase() }),
        // A school admin is confined to their own school; a super_admin is not,
        // which is the only case that can legitimately record against another
        // school's student.
        ...(user.role === "super_admin" ? {} : { schoolId: user.schoolId }),
        deletedAt: null,
      }).session(session);

      if (!student) {
        throw new ApiError("Student not found", 404, "NOT_FOUND");
      }

      const school = await School.findById(student.schoolId).session(session);
      if (!school) {
        throw new ApiError("School not found", 404, "NOT_FOUND");
      }

      const balance = student.balance || 0;

      if (amount > balance && !allowOverpayment) {
        throw new ApiError(
          `That is more than the ${balance} pesewas outstanding. Set allowOverpayment to record a credit.`,
          400,
          "AMOUNT_EXCEEDS_BALANCE"
        );
      }

      const at = receivedAt ? new Date(receivedAt) : new Date();
      const sequence = await nextPaymentSequence(school._id, session);
      const paymentId = `PAY-MAN-${sequence}`;

      const payment = await Payment.create(
        [
          {
            paymentId,
            studentId: student._id,
            schoolId: student.schoolId,
            paymentPlanId: null,
            amount,
            currency: "GHS",
            // `completed` immediately: the money is physically in the bursar's
            // hands, so there is no gateway callback to wait for.
            status: "completed",
            paymentMethod: method,
            provider: "manual",
            momoPhoneNumber: null,
            momoNetwork: "UNKNOWN",
            description: notes || `Manual payment — ${method.replace(/_/g, " ")}`,
            reference: reference || null,
            receiptNumber: `RCP-${paymentId}`,
            receiptGeneratedAt: at,
            initiatedAt: at,
            completedAt: at,
            // Set here, which is what makes a later webhook a no-op.
            settlement: { appliedAt: at, reference: reference || null },
            createdBy: user._id,
          },
        ],
        { session }
      );

      // The student is moved in the same transaction. `totalPaid` and `balance`
      // are the fields the roster, the KPI band and the reports read, so a
      // payment that does not land here is invisible to all of them.
      student.totalPaid = (student.totalPaid || 0) + amount;
      student.balance = (student.totalOwed || 0) - student.totalPaid;
      student.updatedBy = user._id;
      await student.save({ session });

      await School.updateOne(
        { _id: school._id },
        { $inc: { "stats.totalPaymentsThisMonth": 1 } },
        { session }
      );

      await auditService.log({
        action: "RECORD_MANUAL_PAYMENT",
        entity: "Payment",
        entityId: payment[0]._id,
        userId: user._id,
        schoolId: student.schoolId,
        meta: { paymentId, studentRef, amount, method, balanceAfter: student.balance },
      });

      result = {
        payment: payment[0].toJSON(),
        student: {
          _id: student._id,
          studentId: student.studentId,
          studentName: student.studentName,
          totalPaid: student.totalPaid,
          balance: student.balance,
        },
      };
    });

    return result;
  } finally {
    await session.endSession();
  }
};

/**
 * A per-school sequence for the manual-payment id.
 *
 * Counter-based, like `studentId`: `Payment.findOne().sort().limit(1)` is a
 * read-then-write race, and two bursars recording cash at the same moment would
 * produce the same `paymentId` and trip the unique index on one of them.
 */
const nextPaymentSequence = async (schoolId, session) => {
  const year = new Date().getFullYear();
  const doc = await Counter.findOneAndUpdate(
    { key: `payment:manual:${schoolId}:${year}` },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return `${year}-${String(doc?.seq || 1).padStart(6, "0")}`;
};

export default { recordManualPayment };
