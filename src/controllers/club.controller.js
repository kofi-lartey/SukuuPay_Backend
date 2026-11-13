import {
  createClub,
  fetchClubs,
  fetchClubById,
  updateClub,
  toggleClubMembership,
  softDeleteClub,
  fetchClubMembers,
} from "../services/club.service.js";

export const createClubController = async (req, res) => {
  try {
    const club = await createClub(req.body, req.user);

    return res.status(201).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listClubsController = async (req, res) => {
  try {
    const { schoolId } = req.user;
    const { page = 1, perPage = 20 } = req.query;

    const result = await fetchClubs(
      { schoolId, skip: (Number(page) - 1) * Number(perPage), limit: Number(perPage) },
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result.clubs,
      meta: {
        page: Number(page),
        perPage: Number(perPage),
        total: result.total,
        totalPages: Math.ceil(result.total / Number(perPage)),
      },
    });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const getClubController = async (req, res) => {
  try {
    const club = await fetchClubById(req.params.id, req.user);

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const updateClubController = async (req, res) => {
  try {
    const club = await updateClub(req.params.id, req.body, req.user);

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const toggleClubMembershipController = async (req, res) => {
  try {
    const result = await toggleClubMembership(req.params.id, req.user);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const deleteClubController = async (req, res) => {
  try {
    const club = await softDeleteClub(req.params.id, req.user);

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};


/**
 * `GET /api/community/clubs/:clubId/members` - the chat header and @mention source.
 *
 * One call returns the resolved members (both collections), the total and the
 * student count, so the header and the picker agree instead of each deriving a
 * number from a different query.
 */
export const listClubMembersController = async (req, res) => {
  try {
    const result = await fetchClubMembers(req.params.clubId, req.user);
    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export default {
  createClubController,
  listClubsController,
  getClubController,
  updateClubController,
  listClubMembersController,
  toggleClubMembershipController,
  deleteClubController,
};
