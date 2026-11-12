import {
  createEvent,
  fetchEvents,
  fetchEventById,
  updateEvent,
  rsvpEvent,
  deleteEvent,
} from "../services/communityEvent.service.js";

export const createEventController = async (req, res) => {
  try {
    const event = await createEvent(req.body, req.user);
    return res.status(201).json({ success: true, data: event });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const listEventsController = async (req, res) => {
  try {
    const { schoolId } = req.user;
    const { clubId, status, page = 1, perPage = 20 } = req.query;

    const result = await fetchEvents(
      { schoolId, clubId, status, skip: (Number(page) - 1) * Number(perPage), limit: Number(perPage) },
      req.user
    );

    return res.status(200).json({
      success: true,
      data: result.events,
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

export const getEventController = async (req, res) => {
  try {
    const event = await fetchEventById(req.params.id, req.user);
    return res.status(200).json({ success: true, data: event });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const updateEventController = async (req, res) => {
  try {
    const event = await updateEvent(req.params.id, req.body, req.user);
    return res.status(200).json({ success: true, data: event });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const rsvpEventController = async (req, res) => {
  try {
    const event = await rsvpEvent(req.params.id, req.user);
    return res.status(200).json({ success: true, data: event });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export const deleteEventController = async (req, res) => {
  try {
    const event = await deleteEvent(req.params.id, req.user);
    return res.status(200).json({ success: true, data: event });
  } catch (error) {
    return res.status(error.status || 500).json({ success: false, message: error.message });
  }
};

export default {
  createEventController,
  listEventsController,
  getEventController,
  updateEventController,
  rsvpEventController,
  deleteEventController,
};