/**
 * Who is online, per school.
 *
 * ## Why in memory
 *
 * Presence is a property of live sockets, not of the database. A `lastSeenAt`
 * column would have to be written on every heartbeat and would still be a guess:
 * "online" means *has an open connection right now*, which only the socket layer
 * knows. So the registry lives beside the gateway.
 *
 * ## Why it is its own module
 *
 * Both the gateway and a controller need it. Importing the gateway from a
 * controller would drag `index.js` in — which imports the routes, which import the
 * controller — and produce a cycle that fails at load time. A leaf module with no
 * imports is the cheap way out.
 *
 * ## The multi-instance caveat, stated rather than hidden
 *
 * This is per-process. Behind two dynos, each sees only its own connections and
 * the count is roughly half the truth. The fix is the socket.io Redis adapter,
 * which makes the rooms cluster-wide; until then a single instance is assumed.
 * When that changes, this module is the only thing that has to move.
 */

/** schoolId -> Set of userIds with at least one open connection. */
const onlineBySchool = new Map();

const key = (schoolId) => String(schoolId);

/**
 * Counts connections, not users: one person with three tabs is one entry in the
 * set, because the set is keyed by user id.
 */
export const addPresence = (schoolId, userId) => {
  if (!schoolId || !userId) return;

  const id = key(schoolId);
  if (!onlineBySchool.has(id)) onlineBySchool.set(id, new Set());
  onlineBySchool.get(id).add(String(userId));
};

export const removePresence = (schoolId, userId) => {
  if (!schoolId || !userId) return;

  const id = key(schoolId);
  const set = onlineBySchool.get(id);
  if (!set) return;

  set.delete(String(userId));
  if (set.size === 0) onlineBySchool.delete(id);
};

/** Array, because it crosses a JSON boundary and a Set does not. */
export const onlineUserIdsFor = (schoolId) => {
  if (!schoolId) return [];
  return [...(onlineBySchool.get(key(schoolId)) || [])];
};

export const onlineCountFor = (schoolId) => onlineUserIdsFor(schoolId).length;

export default { addPresence, removePresence, onlineUserIdsFor, onlineCountFor };