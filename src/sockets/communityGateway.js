import { authenticateUser } from "../middleware/authenticate.js";
import { COMMUNITY_ALLOWED_ROLES, resolveRole } from "../middleware/communityAuth.js";

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
 *   - community:club_updated { postId, action: "created" | "updated" | "membership" }
 */

/** `school:<24-hex>` — the only room shape this gateway ever joins. */
const SCHOOL_ROOM = /^school:[a-f0-9]{24}$/i;

const createCommunityGateway = (io) => {
  io.on("connection", async (socket) => {
    const token = socket.handshake.auth?.token || socket.auth?.token;
    let user;
    try {
      user = await authenticateUser(token);
    } catch (error) {
      // Without this the only symptom was a socket that never joined a room,
      // which is indistinguishable from a quiet feed. The reason is logged so a
      // bad/expired token is diagnosable instead of mysterious.
      console.warn(
        "[CommunitySocket] rejected handshake:",
        error?.message,
        "| token:",
        token ? `${String(token).slice(0, 8)}…` : "(none)"
      );
      socket.disconnect(true);
      return;
    }

    if (!user) {
      console.warn("[CommunitySocket] rejected handshake: no principal resolved");
      socket.disconnect(true);
      return;
    }

    /*
     * The allow-list is imported from `communityAuth` rather than restated. Two
     * copies of "who may use community" drift apart the moment one is edited,
     * and a drifted socket copy fails silently by disconnecting.
     */
    const role = resolveRole(user);
    if (!COMMUNITY_ALLOWED_ROLES.includes(role)) {
      console.warn(`[CommunitySocket] rejected role '${role}' for user ${user._id}`);
      socket.disconnect(true);
      return;
    }

    const schoolId = user.schoolId ? String(user.schoolId) : null;

    socket.on("community:join", (payload = {}) => {
      const requested = payload?.room;

      /*
       * The room is derived from the authenticated principal, never taken from
       * the client. The previous code joined `payload.room` verbatim, so any
       * signed-in user could subscribe to `school:<someone else's id>` and read
       * that school's feed and chat.
       *
       * A super_admin has no school of their own, so they may name a room —
       * still constrained to the one shape this gateway knows, which blocks a
       * crafted name from reaching an unrelated Socket.io namespace.
       */
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