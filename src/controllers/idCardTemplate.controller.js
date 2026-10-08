import {
  listIdCardTemplates,
  getIdCardTemplate,
  createIdCardTemplate,
  updateIdCardTemplate,
  deleteIdCardTemplate,
  duplicateIdCardTemplate,
  setDefaultIdCardTemplate,
} from "../services/idCardTemplate.service.js";

// ── GET /id-card-templates — list all templates ──
export const listIdCardTemplatesController = async (req, res) => {
  try {
    const templates = await listIdCardTemplates(req.params.schoolId, req.user);

    return res.status(200).json({
      success: true,
      message: "Templates retrieved successfully",
      data: templates,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── GET /id-card-templates/:templateId — get single template ──
export const getIdCardTemplateController = async (req, res) => {
  try {
    const template = await getIdCardTemplate(req.params.templateId, req.user);

    return res.status(200).json({
      success: true,
      message: "Template retrieved successfully",
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── POST /id-card-templates/:schoolId — create a template ──
export const createIdCardTemplateController = async (req, res) => {
  try {
    const template = await createIdCardTemplate(req.body, req.user);

    return res.status(201).json({
      success: true,
      message: "Template created successfully",
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /id-card-templates/:templateId — update a template ──
export const updateIdCardTemplateController = async (req, res) => {
  try {
    const template = await updateIdCardTemplate(req.params.templateId, req.body, req.user);

    return res.status(200).json({
      success: true,
      message: "Template updated successfully",
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── DELETE /id-card-templates/:templateId — soft delete a template ──
export const deleteIdCardTemplateController = async (req, res) => {
  try {
    const result = await deleteIdCardTemplate(req.params.templateId, req.user);

    return res.status(200).json({
      success: true,
      message: "Template deleted successfully",
      data: result,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── POST /id-card-templates/:templateId/duplicate — clone a template ──
export const duplicateIdCardTemplateController = async (req, res) => {
  try {
    const template = await duplicateIdCardTemplate(req.params.templateId, req.body, req.user);

    return res.status(201).json({
      success: true,
      message: "Template duplicated successfully",
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};

// ── PUT /id-card-templates/:templateId/set-default — set as default for audience ──
export const setDefaultIdCardTemplateController = async (req, res) => {
  try {
    const template = await setDefaultIdCardTemplate(req.params.templateId, req.user);

    return res.status(200).json({
      success: true,
      message: "Template set as default successfully",
      data: template,
    });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
    });
  }
};
