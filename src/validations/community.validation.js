import Joi from "joi";

export const createPostSchema = Joi.object({
  postType: Joi.string().valid("discussion", "question", "poll", "resource").default("discussion"),
  title: Joi.string().trim().max(300).allow(null, ""),
  body: Joi.string().trim().max(8000).allow(null, ""),
  tags: Joi.array().items(Joi.string().trim().lowercase().max(40)).default([]),
  clubId: Joi.string().hex().length(24).allow(null, ""),
  media: Joi.array().items(
    Joi.object({
      url: Joi.string().uri().required(),
      publicId: Joi.string().allow(""),
      mimeType: Joi.string().allow(""),
      bytes: Joi.number().min(0).allow(null),
      originalName: Joi.string().trim().max(255).allow(""),
      durationSeconds: Joi.number().min(0).allow(null),
    })
  ).default([]),
}).or("title", "body");

export const listPostsSchema = Joi.object({
  clubId: Joi.string().hex().length(24).allow(null, ""),
  postType: Joi.string().valid("discussion", "question", "poll", "resource").allow(null, ""),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const postIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

export const togglePostStatusSchema = Joi.object({
  status: Joi.string().valid("active", "archived").required(),
});

export const createPollSchema = Joi.object({
  question: Joi.string().trim().max(300).required(),
  options: Joi.array()
    .items(Joi.string().trim().max(200))
    .min(2)
    .max(10)
    .required(),
  expiresAt: Joi.date().allow(null, ""),
});

export const createCommentSchema = Joi.object({
  postId: Joi.string().hex().length(24).required(),
  parentCommentId: Joi.string().hex().length(24).allow(null, ""),
  body: Joi.string().trim().max(8000).allow(null, ""),
  media: Joi.array()
    .items(
      Joi.object({
        url: Joi.string().uri().required(),
        publicId: Joi.string().allow(""),
        mimeType: Joi.string().allow(""),
        bytes: Joi.number().min(0).allow(null),
        originalName: Joi.string().trim().max(255).allow(""),
        durationSeconds: Joi.number().min(0).allow(null),
      })
    )
    .default([]),
  forwardedFrom: Joi.string().hex().length(24).allow(null, ""),
  // The ids the client resolved from its member list. The name is a display
  // snapshot, not authority: the service re-checks every id against the caller's
  // school before storing, so a forged id either resolves or is dropped.
  mentions: Joi.array()
    .items(
      Joi.object({
        userId: Joi.string().hex().length(24).required(),
        name: Joi.string().trim().max(100).allow(null, ""),
      })
    )
    .max(20)
    .default([]),
})
  // A chat message needs *something*: text, a file, or a forward. Without this a
  // request carrying only a `postId` produced an empty row.
  .or("body", "media", "forwardedFrom");

export const listCommentsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
  // Derived filters - see COMMENT_FILTERS in the service. `mentions` is scoped to the
  // caller by the service, never by the client.
  filter: Joi.string().valid("questions", "files", "links", "mentions"),
  q: Joi.string().trim().max(100).allow(null, ""),
});

export const commentIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
  postId: Joi.string().hex().length(24).required(),
});

export const addReactionSchema = Joi.object({
  targetId: Joi.string().hex().length(24).required(),
  targetType: Joi.string().valid("post", "comment").required(),
  reactionType: Joi.string().valid("like", "helpful", "fire", "support").required(),
});

export const reactionParamSchema = Joi.object({
  targetId: Joi.string().hex().length(24).required(),
  targetType: Joi.string().valid("post", "comment").required(),
});

export const createClubSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100).required(),
  description: Joi.string().trim().max(2000).allow(""),
  category: Joi.string().trim().lowercase().valid("academic", "hobby", "sports", "tech").required(),
  privacy: Joi.string().valid("public", "private").default("public"),
  eligibleRoles: Joi.array()
    .items(Joi.string().valid("student", "teacher", "school_admin", "accountant"))
    .min(1)
    .default(["student", "teacher", "school_admin", "accountant"]),
  password: Joi.string().trim().min(4).max(128).allow(""),
});

export const listClubsSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

export const toggleClubMembershipSchema = Joi.object({
  password: Joi.string().trim().max(128).allow(""),
});

export const clubIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

export const updateClubSchema = Joi.object({
  name: Joi.string().trim().min(1).max(100),
  description: Joi.string().trim().max(2000).allow(""),
  category: Joi.string().valid("academic", "hobby", "sports", "tech"),
  privacy: Joi.string().valid("public", "private"),
  eligibleRoles: Joi.array()
    .items(Joi.string().valid("student", "teacher", "school_admin", "accountant"))
    .min(1),
  // `Club.password` is `select: false`, so the edit form can never pre-fill the
  // stored hash. The three states are therefore explicit:
  //   - absent/blank string  -> leave unchanged
  //   - non-empty string     -> replace the hash
  //   - `removePassword`     -> clear it
  // A blank string meaning both "keep" and "clear" would make it impossible to
  // express removal, hence the separate flag.
  password: Joi.string().trim().min(4).max(128).allow(""),
  removePassword: Joi.boolean(),
}).min(1);
export const createEventSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200).required(),
  description: Joi.string().trim().max(4000).allow(""),
  eventType: Joi.string().valid("meeting", "competition", "trip", "activity", "virtual").default("activity"),
  startAt: Joi.date().required(),
  endAt: Joi.date().allow(null, ""),
  location: Joi.string().trim().max(300).allow(""),
  isVirtual: Joi.boolean().default(false),
  clubId: Joi.string().hex().length(24).allow(null, ""),
});

export const updateEventSchema = Joi.object({
  title: Joi.string().trim().min(1).max(200),
  description: Joi.string().trim().max(4000).allow(""),
  eventType: Joi.string().valid("meeting", "competition", "trip", "activity", "virtual"),
  startAt: Joi.date(),
  endAt: Joi.date().allow(null, ""),
  location: Joi.string().trim().max(300).allow(""),
  isVirtual: Joi.boolean(),
  status: Joi.string().valid("draft", "published", "cancelled"),
}).min(1);

export const eventIdParamSchema = Joi.object({
  id: Joi.string().hex().length(24).required(),
});

export const listEventsSchema = Joi.object({
  clubId: Joi.string().hex().length(24).allow(null, ""),
  status: Joi.string().valid("draft", "published", "cancelled").allow(null, ""),
  page: Joi.number().integer().min(1).default(1),
  perPage: Joi.number().integer().min(1).max(100).default(20),
});

/**
 * `PATCH /api/community/comments/:id`
 *
 * The edit window is enforced in the service against `createdAt`, not here: Joi
 * can validate that a body was supplied, but "is this message still editable" is a
 * database question about the author and the clock.
 */
export const updateCommentSchema = Joi.object({
  body: Joi.string().trim().max(8000).required(),
});

/**
 * `POST /api/community/link-preview`
 *
 * Used by the composer to show a card *before* the message is sent. The server
 * derives the authoritative preview when the message is stored, so this endpoint
 * is a preview of a preview - the client cannot post a card the server would not
 * have produced.
 */
export const linkPreviewSchema = Joi.object({
  url: Joi.string().trim().max(2048).required(),
});
/**
 * `POST /api/community/clubs/:clubId/chat`
 *
 * A separate schema from `clubIdParamSchema` because the parameter is named
 * `clubId`, not `id`. Validating this route with `clubIdParamSchema` made every
 * request fail with 422: Joi required an `id` the route never supplies.
 */
export const clubChatParamSchema = Joi.object({
  clubId: Joi.string().hex().length(24).required(),
});