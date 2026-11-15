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
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
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

/**
 * `PUT /api/community/clubs/:id` — creator-only.
 *
 * `code` is forwarded because the client branches on it: `CLUB_NOT_CREATOR`
 * (403) tells the edit dialog "this club is not yours", while `CLUB_NOT_FOUND`
 * (404) tells it "this club no longer exists". Dropping the code — which this
 * handler used to do, returning only `message` — left the client string-matching
 * a human sentence to tell those two apart.
 */
export const updateClubController = async (req, res) => {
  try {
    const club = await updateClub(req.params.id, req.body, req.user);

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const toggleClubMembershipController = async (req, res) => {
  try {
    const result = await toggleClubMembership(req.params.id, req.user, req.body.password);

    return res.status(200).json({ success: true, data: result });
  } catch (error) {
    // `code` is the whole point here: `CLUB_PASSWORD_REQUIRED` is what tells the
    // client to open the password dialog instead of reporting a generic failure.
    // Without it the browser cannot distinguish "enter the password" from a real
    // refusal, so joining a password-protected club always looked like an error.
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
  }
};

export const deleteClubController = async (req, res) => {
  try {
    const club = await softDeleteClub(req.params.id, req.user);

    return res.status(200).json({ success: true, data: club });
  } catch (error) {
    return res.status(error.status || 500).json({
      success: false,
      message: error.message,
      code: error.code,
    });
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
