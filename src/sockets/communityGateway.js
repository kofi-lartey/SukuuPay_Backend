import { authenticateUser } from "../middleware/authenticate.js";
import { COMMUNITY_ALLOWED_ROLES, resolveRole } from "../middleware/communityAuth.js";
import { addPresence, removePresence, onlineUserIdsFor } from "./presence.js";

/**
 * Community Socket.io gateway.
 *
 * Authenticated rooms are keyed by schoolId: a student in Tamale's community
 * room should never hear Accra's. The client connects with the same bearer token
 * it sends to `/api`, and the handshake carries the user id â€” the same user doc
 * the `authenticate` middleware resolves â€” so the room join is an authorization
 * decision, not a naming preference.
 *
 * ## Why authentication is middleware, not inline
 *
 * The previous version authenticated inside the async `connection` handler. The
 * client's `connect` event then fired before the server finished the database
 * lookup, and any event emitted immediately afterwards - `community:join`,
 * typing, recording - was dropped because the handler had not been registered
 * yet. That is why presence stayed at zero and messages needed a reload.
 *
 * Running it as `io.use(...)` means that by the time `io.on("connection", ...)`
 * fires, the socket is already authenticated and the handlers below are registered
 * synchronously.
 *
 * Events:
 *   - community:join        { room: schoolId }
 *   - community:post_created { postId }
 *   - community:post_deleted { postId }
 *   - community:comment_created { postId, commentId }
 *   - community:reaction     { targetId, targetType, reactionType }
 *   - community:club_updated { postId, action: "created" | "updated" | "membership" }
 *   - community:presence     { userIds }
 *   - community:typing       { userId, name, isTyping }
 *   - community:recording    { userId, name, isRecording }
 */

/** `school:<24-hex>` â€” the only room shape this gateway ever joins. */
const SCHOOL_ROOM = /^school:[a-f0-9]{24}$/i;

const createCommunityGateway = (io) => {
  io.use(async (socket, next) => {
    const token = socket.handshake.auth?.token || socket.auth?.token;
    let user;
    try {
      user = await authenticateUser(token);
    } catch (error) {
      console.warn(
        "[CommunitySocket] rejected handshake:",
        error?.message,
        "| token:",
        token ? `${String(token).slice(0, 8)}â€¦` : "(none)"
      );
      return next(new Error(error?.message || "Authentication required"));
    }

    if (!user) {
      console.warn("[CommunitySocket] rejected handshake: no principal resolved");
      return next(new Error("Authentication required"));
    }

    const role = resolveRole(user);
    if (!COMMUNITY_ALLOWED_ROLES.includes(role)) {
      console.warn(`[CommunitySocket] rejected role '${role}' for user ${user._id}`);
      return next(new Error("Community access is not available"));
    }

    socket.data.user = user;
    socket.data.role = role;
    socket.data.schoolId = user.schoolId ? String(user.schoolId) : null;

    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    const role = socket.data.role;
    const schoolId = socket.data.schoolId;

    // Register the handlers synchronously, before any async work.
    socket.on("community:join", (payload = {}) => {
      const requested = payload?.room;

      if (role === "super_admin") {
        if (requested && SCHOOL_ROOM.test(requested)) {
          socket.join(requested);
          console.log(`[CommunitySocket] super_admin joined ${requested}`);
        }
        return;
      }

      const room = schoolId ? `school:${schoolId}` : null;
      if (!room) {
        console.warn(`[CommunitySocket] user ${user._id} has no school; join ignored`);
        return;
      }
      if (requested && requested !== room) {
        console.warn(
          `[CommunitySocket] user ${user._id} asked for ${requested}; joined ${room} instead`
        );
      }
      socket.join(room);
    });

    // Presence starts when the handshake is accepted.
    addPresence(schoolId, String(user._id));
    io.to(`school:${schoolId}`).emit("community:presence", {
      userIds: onlineUserIdsFor(schoolId),
    });

    /*
     * Ephemeral activity. Neither of these is persisted: they describe what is
     * happening right now, and a row in the database would be wrong a second later.
     * Both are relayed to the room except the sender, who already knows.
     */
    socket.on("community:typing", (payload = {}) => {
      socket.to(`school:${schoolId}`).emit("community:typing", {
        userId: String(user._id),
        name: user.firstName || user.name || null,
        isTyping: Boolean(payload.isTyping),
      });
    });

    socket.on("community:recording", (payload = {}) => {
      socket.to(`school:${schoolId}`).emit("community:recording", {
        userId: String(user._id),
        name: user.firstName || user.name || null,
        isRecording: Boolean(payload.isRecording),
      });
    });

    socket.on("disconnect", () => {
      removePresence(schoolId, String(user._id));
      io.to(`school:${schoolId}`).emit("community:presence", {
        userIds: onlineUserIdsFor(schoolId),
      });
    });
  });

  return {
    /** Broadcast a new post to everyone in the school's community room. */
    postCreated: (schoolId, post) => {
      io.to(`school:${schoolId}`).emit("community:post_created", { postId: post?._id });
    },

    /** Broadcast a soft-deleted post so readers drop it. */
    postDeleted: (schoolId, postId) => {
      io.to(`school:${schoolId}`).emit("community:post_deleted", { postId });
    },

    /** Broadcast a comment so open threads move without a refetch. */
    commentCreated: (schoolId, { postId, commentId }) => {
      io.to(`school:${schoolId}`).emit("community:comment_created", { postId, commentId });
    },

    /** Broadcast a reaction tally change. */
    reaction: (schoolId, targetId, targetType, reactionType) => {
      io.to(`school:${schoolId}`).emit("community:reaction", {
        targetId,
        targetType,
        reactionType,
      });
    },

    /** Broadcast club lifecycle events. */
    clubUpdated: (schoolId, { clubId, action }) => {
      io.to(`school:${schoolId}`).emit("community:club_updated", { clubId, action });
    },
  };
};

export default createCommunityGateway;
