import mongoose from "mongoose";
import { IdCardTemplate } from "../models/IdCardTemplate.js";
import { AUDIT_ACTIONS } from "../config/constants.js";
import { log as auditLog } from "../utils/auditService.js";
import ApiError from "../utils/ApiError.js";

const resolveSchoolId = (user, explicitSchoolId) => {
  if (user && user.role === "super_admin") {
    return explicitSchoolId ? new mongoose.Types.ObjectId(explicitSchoolId) : null;
  }
  return user && user.schoolId ? new mongoose.Types.ObjectId(user.schoolId) : null;
};

const slugify = (name) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

const DEFAULT_TEMPLATE_FIELDS = {
  showPhoto: true,
  showQr: true,
  showStamp: true,
  showEmergency: true,
  showGuardian: true,
  showClass: true,
  showStudentId: true,
};

export const listIdCardTemplates = async (schoolId, requester) => {
  const scopedSchoolId = resolveSchoolId(requester, schoolId);
  if (!scopedSchoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  return IdCardTemplate.find({
    schoolId: scopedSchoolId,
    deletedAt: null,
  })
    .sort({ createdAt: -1 })
    .lean();
};

export const getIdCardTemplate = async (templateId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const template = await IdCardTemplate.findOne({
    _id: templateId,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!template) throw new ApiError("Template not found", 404, "NOT_FOUND");
  return template;
};

export const createIdCardTemplate = async (data, requester) => {
  const schoolId = resolveSchoolId(requester, data.schoolId);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const { name, audience = "student", fields = {}, layout = {}, theme = {}, text = {} } = data;

  if (!name || name.trim().length === 0) {
    throw new ApiError("Template name is required", 400, "VALIDATION_ERROR");
  }

  const slug = slugify(name);

  const existing = await IdCardTemplate.findOne({
    schoolId,
    slug,
    deletedAt: null,
  });
  if (existing) {
    throw new ApiError(
      `A template with slug "${slug}" already exists`,
      409,
      "DUPLICATE_SLUG"
    );
  }

  let isDefault = false;
  if (data.isDefault) {
    await IdCardTemplate.updateOne(
      { schoolId, audience, isDefault: true, deletedAt: null },
      { $set: { isDefault: false } }
    );
    isDefault = true;
  }

  const template = await IdCardTemplate.create({
    schoolId,
    name: name.trim(),
    slug,
    isSystem: false,
    audience,
    fields: { ...DEFAULT_TEMPLATE_FIELDS, ...fields },
    layout: {
      sheetLayout: layout.sheetLayout || "6up_a4_landscape",
      sides: layout.sides || "front_back",
      includeCutGuides: layout.includeCutGuides || false,
    },
    theme: {
      brandColor: theme.brandColor || null,
      accentColor: theme.accentColor || null,
    },
    text: {
      termsOverride: text.termsOverride || null,
      footerLeft: text.footerLeft || "SUKUUPAY",
      footerRight: text.footerRight || null,
    },
    createdBy: requester._id,
  });

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_TEMPLATE_CREATE || "id_card.template.create",
    entity: "IdCardTemplate",
    entityId: template._id,
    userId: requester._id,
    schoolId,
    meta: { name, audience, slug },
  });

  return template;
};

export const updateIdCardTemplate = async (templateId, data, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const template = await IdCardTemplate.findOne({
    _id: templateId,
    schoolId,
    deletedAt: null,
  });

  if (!template) throw new ApiError("Template not found", 404, "NOT_FOUND");

  if (template.isSystem) {
    throw new ApiError(
      "System templates cannot be modified",
      403,
      "CANNOT_MODIFY_SYSTEM_TEMPLATE"
    );
  }

  const { name, audience, fields, layout, theme, text } = data;

  if (name !== undefined) {
    template.name = name.trim();
    template.slug = slugify(name);

    const existing = await IdCardTemplate.findOne({
      schoolId,
      slug: template.slug,
      _id: { $ne: templateId },
      deletedAt: null,
    });
    if (existing) {
      throw new ApiError("A template with this name already exists", 409, "DUPLICATE_NAME");
    }
  }

  if (audience !== undefined) template.audience = audience;
  if (fields !== undefined) template.fields = { ...DEFAULT_TEMPLATE_FIELDS, ...fields };
  if (layout !== undefined) template.layout = { ...template.layout, ...layout };
  if (theme !== undefined) template.theme = { ...template.theme, ...theme };
  if (text !== undefined) template.text = { ...template.text, ...text };

  if (data.isDefault === true && template.isDefault === false) {
    await IdCardTemplate.updateOne(
      {
        schoolId,
        audience: template.audience,
        isDefault: true,
        deletedAt: null,
        _id: { $ne: templateId },
      },
      { $set: { isDefault: false } }
    );
    template.isDefault = true;
  }

  template.updatedBy = requester._id;
  await template.save();

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_TEMPLATE_UPDATE || "id_card.template.update",
    entity: "IdCardTemplate",
    entityId: templateId,
    userId: requester._id,
    schoolId,
    meta: { name: template.name, audience: template.audience },
  });

  return template.toJSON();
};

export const deleteIdCardTemplate = async (templateId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const template = await IdCardTemplate.findOne({
    _id: templateId,
    schoolId,
    deletedAt: null,
  });

  if (!template) throw new ApiError("Template not found", 404, "NOT_FOUND");

  if (template.isSystem) {
    throw new ApiError(
      "System templates cannot be deleted",
      403,
      "CANNOT_DELETE_SYSTEM_TEMPLATE"
    );
  }

  if (template.isDefault) {
    const anotherDefault = await IdCardTemplate.findOne({
      schoolId,
      audience: template.audience,
      isDefault: true,
      deletedAt: null,
      _id: { $ne: templateId },
    });

    if (!anotherDefault) {
      throw new ApiError(
        "Cannot delete the only default template for this audience. Set another template as default first.",
        400,
        "CANNOT_DELETE_LAST_DEFAULT"
      );
    }
  }

  template.deletedAt = new Date();
  await template.save();

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_TEMPLATE_DELETE || "id_card.template.delete",
    entity: "IdCardTemplate",
    entityId: templateId,
    userId: requester._id,
    schoolId,
    meta: { name: template.name, audience: template.audience },
  });

  return { success: true };
};

export const duplicateIdCardTemplate = async (templateId, data, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const source = await IdCardTemplate.findOne({
    _id: templateId,
    schoolId,
    deletedAt: null,
  }).lean();

  if (!source) throw new ApiError("Template not found", 404, "NOT_FOUND");

  const newName = data.name || `${source.name} (copy)`;
  const slug = slugify(newName) + "-" + Date.now().toString().slice(-6);

  const duplicate = await IdCardTemplate.create({
    schoolId,
    name: newName,
    slug,
    isSystem: false,
    audience: source.audience,
    fields: source.fields,
    layout: source.layout,
    theme: source.theme,
    text: source.text,
    isDefault: false,
    createdBy: requester._id,
  });

  await auditLog({
    action: AUDIT_ACTIONS.ID_CARD_TEMPLATE_DUPLICATE || "id_card.template.duplicate",
    entity: "IdCardTemplate",
    entityId: duplicate._id,
    userId: requester._id,
    schoolId,
    meta: { sourceTemplateId: templateId, name: newName },
  });

  return duplicate.toJSON();
};

export const setDefaultIdCardTemplate = async (templateId, requester) => {
  const schoolId = resolveSchoolId(requester);
  if (!schoolId) {
    throw new ApiError("No school in scope", 403, "NO_SCHOOL_SCOPE");
  }

  const session = await IdCardTemplate.startSession();
  session.startTransaction();

  try {
    const template = await IdCardTemplate.findOne({
      _id: templateId,
      schoolId,
      deletedAt: null,
    }).session(session);

    if (!template) throw new ApiError("Template not found", 404, "NOT_FOUND");

    await IdCardTemplate.updateOne(
      {
        schoolId,
        audience: template.audience,
        isDefault: true,
        deletedAt: null,
        _id: { $ne: templateId },
      },
      { $set: { isDefault: false } }
    ).session(session);

    template.isDefault = true;
    await template.save({ session });

    await auditLog(
      {
        action: AUDIT_ACTIONS.ID_CARD_TEMPLATE_SET_DEFAULT || "id_card.template.set_default",
        entity: "IdCardTemplate",
        entityId: templateId,
        userId: requester._id,
        schoolId,
        meta: { name: template.name, audience: template.audience },
      },
      { session }
    );

    await session.commitTransaction();
    session.endSession();

    return template.toJSON();
  } catch (error) {
    await session.abortTransaction();
    session.endSession();
    throw error;
  }
};

export default {
  listIdCardTemplates,
  getIdCardTemplate,
  createIdCardTemplate,
  updateIdCardTemplate,
  deleteIdCardTemplate,
  duplicateIdCardTemplate,
  setDefaultIdCardTemplate,
};