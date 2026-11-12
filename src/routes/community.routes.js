import { Router } from "express";
import { authenticate } from "../middleware/authenticate.js";
import { communityAuth, resolveCommunitySchool } from "../middleware/communityAuth.js";
import { validate } from "../middleware/validate.js";
import {
  createPostController,
  listPostsController,
  getPostController,
  deletePostController,
  togglePostStatusController,
  toggleBookmarkController,
  createPollController,
} from "../controllers/community.post.controller.js";
import {
  createCommentController,
  listCommentsController,
  toggleAcceptAnswerController,
  deleteCommentController,
} from "../controllers/community.comment.controller.js";
import {
  addReactionController,
  listReactionsController,
  getReactionCountController,
  removeReactionController,
} from "../controllers/community.reaction.controller.js";
import {
  createClubController,
  listClubsController,
  getClubController,
  updateClubController,
  toggleClubMembershipController,
  deleteClubController,
} from "../controllers/club.controller.js";
import {
  createEventController,
  listEventsController,
  getEventController,
  updateEventController,
  rsvpEventController,
  deleteEventController,
} from "../controllers/community.event.controller.js";
import {
  createPostSchema,
  listPostsSchema,
  postIdParamSchema,
  togglePostStatusSchema,
  createPollSchema,
  createCommentSchema,
  listCommentsSchema,
  addReactionSchema,
  reactionParamSchema,
  createClubSchema,
  listClubsSchema,
  clubIdParamSchema,
  updateClubSchema,
  commentIdParamSchema,
  createEventSchema,
  updateEventSchema,
  eventIdParamSchema,
  listEventsSchema,
} from "../validations/community.validation.js";

export const communityRoute = Router();

// Ensure authentication on all community routes
communityRoute.use(authenticate);

/**
 * Posts: /api/community/posts
 *
 * All routes require `communityAuth` (rejects parent roles).
 * super_admin may pass explicit schoolId in query; everyone else is pinned to their own school.
 */
communityRoute.post(
  "/posts",
  communityAuth,
  validate(createPostSchema),
  createPostController
);

communityRoute.post(
  "/posts/poll",
  communityAuth,
  validate(createPollSchema),
  createPollController
);

communityRoute.get(
  "/posts",
  communityAuth,
  validate(listPostsSchema, "query"),
  listPostsController
);

communityRoute.get(
  "/posts/:id",
  communityAuth,
  validate(postIdParamSchema, "params"),
  getPostController
);

communityRoute.delete(
  "/posts/:id",
  communityAuth,
  validate(postIdParamSchema, "params"),
  deletePostController
);

communityRoute.put(
  "/posts/:id/status",
  communityAuth,
  validate(postIdParamSchema, "params"),
  validate(togglePostStatusSchema),
  togglePostStatusController
);

communityRoute.put(
  "/posts/:id/bookmark",
  communityAuth,
  validate(postIdParamSchema, "params"),
  toggleBookmarkController
);

/**
 * Comments: /api/community/posts/:postId/comments
 *
 * All routes require `communityAuth`.
 */
communityRoute.post(
  "/posts/:postId/comments",
  communityAuth,
  validate(createCommentSchema),
  createCommentController
);

communityRoute.get(
  "/posts/:postId/comments",
  communityAuth,
  validate(listCommentsSchema, "query"),
  listCommentsController
);

communityRoute.put(
  "/posts/:postId/comments/:id/accept",
  communityAuth,
  validate(commentIdParamSchema, "params"),
  toggleAcceptAnswerController
);

communityRoute.delete(
  "/posts/:postId/comments/:id",
  communityAuth,
  validate(commentIdParamSchema, "params"),
  deleteCommentController
);

/**
 * Reactions: /api/community/reactions
 *
 * All routes require `communityAuth`.
 */
communityRoute.post(
  "/reactions",
  communityAuth,
  validate(addReactionSchema),
  addReactionController
);

communityRoute.get(
  "/reactions/:targetType/:targetId",
  communityAuth,
  validate(reactionParamSchema, "params"),
  listReactionsController
);

communityRoute.get(
  "/reactions/:targetType/:targetId/count",
  communityAuth,
  validate(reactionParamSchema, "params"),
  getReactionCountController
);

communityRoute.delete(
  "/reactions/:targetType/:targetId",
  communityAuth,
  validate(reactionParamSchema, "params"),
  removeReactionController
);

/**
 * Clubs: /api/community/clubs
 *
 * All routes require `communityAuth`.
 */
communityRoute.post(
  "/clubs",
  communityAuth,
  validate(createClubSchema),
  createClubController
);

communityRoute.get(
  "/clubs",
  communityAuth,
  validate(listClubsSchema, "query"),
  listClubsController
);

communityRoute.get(
  "/clubs/:id",
  communityAuth,
  validate(clubIdParamSchema, "params"),
  getClubController
);

communityRoute.put(
  "/clubs/:id",
  communityAuth,
  validate(clubIdParamSchema, "params"),
  validate(updateClubSchema),
  updateClubController
);

communityRoute.put(
  "/clubs/:id/membership",
  communityAuth,
  validate(clubIdParamSchema, "params"),
  toggleClubMembershipController
);

communityRoute.delete(
  "/clubs/:id",
  communityAuth,
  validate(clubIdParamSchema, "params"),
  deleteClubController
);


/**
 * Events: /api/community/events
 */
communityRoute.post(
  "/events",
  communityAuth,
  validate(createEventSchema),
  createEventController
);

communityRoute.get(
  "/events",
  communityAuth,
  validate(listEventsSchema, "query"),
  listEventsController
);

communityRoute.get(
  "/events/:id",
  communityAuth,
  validate(eventIdParamSchema, "params"),
  getEventController
);

communityRoute.put(
  "/events/:id",
  communityAuth,
  validate(eventIdParamSchema, "params"),
  validate(updateEventSchema),
  updateEventController
);

communityRoute.put(
  "/events/:id/rsvp",
  communityAuth,
  validate(eventIdParamSchema, "params"),
  rsvpEventController
);

communityRoute.delete(
  "/events/:id",
  communityAuth,
  validate(eventIdParamSchema, "params"),
  deleteEventController
);

export default communityRoute;