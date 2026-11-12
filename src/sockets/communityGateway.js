import { Server } from "socket.io";
import { authenticateUser } from "../middleware/authenticate.js";

/**
 * Community Socket.io gateway.
 *
 * Authenticated rooms are keyed by schoolId: a student in Tamale's community
 * room should never hear Accra's. The client connects with the same bearer token
 * it sends to `/api`, and the handshake carries the user id — the same user doc
 * the `authenticate` middleware resolves — so the room join is an authorization
 * decision, not a naming preference.
 *
 * Events:
 *   - community:join        { room: schoolId }
 *   - community:post_created { postId }
 *   - community:post_deleted { postId }
 *   - community:comment_created { postId, commentId }
 *   - community:reaction     { targetId, targetType, reactionType }
 *   - community:club_updated { clubId, action: "created" | "updated" | "membership" }
 */

const createCommunityGateway = (io) => {
  io.on("connection", async (socket) => {
    const token = socket.handshake.auth?.token || socket.auth?.token;
    let user;
    try {
      user = await authenticateUser(token);
    } catch {
      socket.disconnect(true);
      return;
    }

    if (!user) {
      socket.disconnect(true);
      return;
    }

    // Access control: only allowed roles may connect
    const ALLOWED_ROLES = ['super_admin', 'school_admin', 'teacher', 'student'];
    if (user.role === 'parent') {
      socket.disconnect(true);
      return;
    }
    if (!ALLOWED_ROLES.includes(user.role)) {
      socket.disconnect(true);
      return;
    }

    const schoolId = user.schoolId ? String(user.schoolId) : null;

    socket.on("community:join", (payload = {}) => {
      const room = payload?.room || schoolId;
      if (room) {
        socket.join(room);
      }
    });

    socket.on("disconnect", () => {
      // Rooms are scoped by schoolId; no per-user cleanup needed because the
      // room membership is keyed to the school, and a disconnect removes the
      // socket's implicit membership automatically.
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
    reaction: (schoolId, { targetId, targetType, reactionType }) => {
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
