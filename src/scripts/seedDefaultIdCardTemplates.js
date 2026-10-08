import mongoose from 'mongoose';
import { School } from '../models/schoolModel.js';
import { IdCardTemplate } from '../models/IdCardTemplate.js';

/**
 * Seeds the two default ID card templates for a school.
 *
 * Called on school creation to ensure every school starts with:
 * 1. "Student ID" — audience: 'student', isDefault: true
 * 2. "Staff ID" — audience: 'staff', isDefault: false
 *
 * System templates (isSystem: true) are marked immutable and cannot be
 * edited or deleted from the UI.
 */
export const seedDefaultIdCardTemplates = async (schoolId, userId) => {
  const studentTemplate = await IdCardTemplate.create({
    schoolId,
    name: 'Student ID',
    slug: 'student-id',
    isSystem: true,
    isDefault: true,
    audience: 'student',
    fields: {
      showPhoto: true,
      showQr: true,
      showStamp: true,
      showEmergency: true,
      showGuardian: true,
      showClass: true,
      showStudentId: true,
    },
    layout: {
      sheetLayout: '6up_a4_landscape',
      sides: 'front_back',
      includeCutGuides: false,
    },
    theme: {
      brandColor: null,
      accentColor: null,
    },
    text: {
      termsOverride: null,
      footerLeft: 'SUKUUPAY',
      footerRight: null,
    },
    createdBy: userId,
  });

  const staffTemplate = await IdCardTemplate.create({
    schoolId,
    name: 'Staff ID',
    slug: 'staff-id',
    isSystem: true,
    isDefault: false,
    audience: 'staff',
    fields: {
      showPhoto: true,
      showQr: true,
      showStamp: true,
      showEmergency: false,
      showGuardian: false,
      showClass: false,
      showStudentId: true,
    },
    layout: {
      sheetLayout: '6up_a4_landscape',
      sides: 'front_back',
      includeCutGuides: false,
    },
    theme: {
      brandColor: null,
      accentColor: null,
    },
    text: {
      termsOverride: null,
      footerLeft: 'SUKUUPAY',
      footerRight: 'STAFF',
    },
    createdBy: userId,
  });

  return { studentTemplate, staffTemplate };
};

/**
 * Seeds default templates for a newly created school.
 * Call this after school creation.
 *
 * @param {mongoose.Types.ObjectId} schoolId
 * @param {mongoose.Types.ObjectId} userId - The user who created the school
 */
export const seedTemplatesForSchool = async (schoolId, userId) => {
  const existing = await IdCardTemplate.find({
    schoolId,
    isSystem: true,
    deletedAt: null,
  });

  if (existing.length > 0) {
    return;
  }

  return seedDefaultIdCardTemplates(schoolId, userId);
};

export default {
  seedDefaultIdCardTemplates,
  seedTemplatesForSchool,
};
