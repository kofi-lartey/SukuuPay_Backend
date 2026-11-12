/**
 * Community event emitters for the Socket.io gateway.
 *
 * These helpers are called from community services to broadcast changes. They
 * are no-ops if Socket.io is not initialized (e.g., in tests), so they are safe
 * to call unconditionally.
 */

let io = null;
let communityGateway = null;

export const setCommunityIO = (ioInstance, gateway) => {
  io = ioInstance;
  communityGateway = gateway;
};

export const emitPostCreated = (schoolId, post) => {
  if (communityGateway) {
    communityGateway.postCreated(schoolId, post);
  }
};

export const emitPostDeleted = (schoolId, postId) => {
  if (communityGateway) {
    communityGateway.postDeleted(schoolId, postId);
  }
};

export const emitCommentCreated = (schoolId, postId, commentId) => {
  if (communityGateway) {
    communityGateway.commentCreated(schoolId, { postId, commentId });
  }
};

export const emitReaction = (schoolId, targetId, targetType, reactionType) => {
  if (communityGateway) {
    communityGateway.reaction(schoolId, { targetId, targetType, reactionType });
  }
};

export const emitClubUpdated = (schoolId, clubId, action) => {
  if (communityGateway) {
    communityGateway.clubUpdated(schoolId, { clubId, action });
  }
};