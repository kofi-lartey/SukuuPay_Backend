import { CommunityEvent } from "../models/CommunityEvent.js";
import ApiError from "../utils/ApiError.js";

export const createEvent = async (payload, user) => {
  const { title, description, eventType, startAt, endAt, location, isVirtual, clubId } = payload;

  if (!title || title.trim().length === 0) {
    throw new ApiError("Event title is required", 400);
  }
  if (!startAt) {
    throw new ApiError("Event start time is required", 400);
  }

  const event = new CommunityEvent({
    schoolId: user.schoolId,
    title: title.trim(),
    description: description ? description.trim() : null,
    createdBy: user._id,
    eventType: eventType || "activity",
    startAt: new Date(startAt),
    endAt: endAt ? new Date(endAt) : null,
    location: location ? location.trim() : null,
    isVirtual: isVirtual || false,
    clubId: clubId || null,
    status: "published",
  });

  await event.save();
  return event;
};

export const fetchEvents = async ({ schoolId, clubId, status, skip = 0, limit = 20 }, user) => {
  const filter = { schoolId };
  if (clubId) filter.clubId = clubId;
  if (status) filter.status = status;

  const events = await CommunityEvent.find(filter)
    .sort({ startAt: 1 })
    .skip(skip)
    .limit(limit)
    .lean();

  const total = await CommunityEvent.countDocuments(filter);
  return { events, total };
};

export const fetchEventById = async (eventId, user) => {
  const event = await CommunityEvent.findById(eventId).lean();
  if (!event) throw new ApiError("Event not found", 404);
  return event;
};

export const updateEvent = async (eventId, payload, user) => {
  const event = await CommunityEvent.findById(eventId);
  if (!event) throw new ApiError("Event not found", 404);

  const { title, description, eventType, startAt, endAt, location, isVirtual, status } = payload;
  if (title !== undefined) event.title = title.trim();
  if (description !== undefined) event.description = description ? description.trim() : null;
  if (eventType !== undefined) event.eventType = eventType;
  if (startAt !== undefined) event.startAt = new Date(startAt);
  if (endAt !== undefined) event.endAt = endAt ? new Date(endAt) : null;
  if (location !== undefined) event.location = location ? location.trim() : null;
  if (isVirtual !== undefined) event.isVirtual = isVirtual;
  if (status !== undefined) event.status = status;

  await event.save();
  return event;
};

export const rsvpEvent = async (eventId, user) => {
  const event = await CommunityEvent.findById(eventId);
  if (!event) throw new ApiError("Event not found", 404);

  const userId = user._id;
  const idx = event.rsvpIds.findIndex((id) => id.toString() === userId.toString());
  if (idx === -1) {
    event.rsvpIds.push(userId);
  } else {
    event.rsvpIds.splice(idx, 1);
  }
  await event.save();
  return event;
};

export const deleteEvent = async (eventId, user) => {
  const event = await CommunityEvent.findById(eventId);
  if (!event) throw new ApiError("Event not found", 404);

  event.status = "cancelled";
  await event.save();
  return event;
};