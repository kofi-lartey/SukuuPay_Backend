/**
 * Who a community post or comment was written by.
 *
 * The community collections store a *snapshot* of the author's display name
 * rather than resolving it on every read, because a feed row is read far more
 * often than it is written and a per-row join would dominate the list query.
 *
 * The snapshot was `null` for every student author, and the reason is a shape
 * mismatch between two collections:
 *
 *   - `authenticate` builds a student principal from the `Student` collection
 *     (`middleware/authenticate.js`), and that collection stores `studentName`,
 *     `firstName`, `lastName` and `studentImage` — it has no `name` and no
 *     `avatar`. The staff principal is a `User` document, which does have both.
 *   - `authorId` was declared `ref: "User"` on both collections, so populating a
 *     student author queried `users` with a `students` `_id` and matched nothing.
 *
 * Reading `user?.name` therefore produced `undefined` for students, and the
 * populate could not repair it afterwards. Both halves are handled here: the
 * write path picks the right name field, and the read path resolves whichever
 * collection the row actually points at.
 */

/**
 * The model a given role's principal lives in. Stored on the row as
 * `authorModel` so `authorId` can use `refPath` and resolve against the right
 * collection for a mixed feed of students and staff.
 */
export const authorModelForRole = (role) => (role === "student" ? "Student" : "User");

/**
 * The display name to snapshot at write time.
 *
 * Students are shown by first name - "Kwame", not "Kwame Mensah Jr" - which is
 * how a school refers to a child in a feed. Staff keep their full `name`, since
 * a `User` document carries no `firstName` and a teacher's full name is the
 * identifier a parent recognises.
 */
export const authorDisplayName = (user) => {
  if (!user) return null;
  return user.firstName || user.name || null;
};

/**
 * The name a populated author document carries, across both collections.
 *
 * `Student` has no `name`: it stores `studentName` plus `firstName`/`lastName`.
 * `User` has `name`. The feed has to accept either, because `authorId` is
 * polymorphic.
 */
export const authorDisplayNameFrom = (author) => {
  if (!author || typeof author !== "object") return null;
  return author.firstName || author.name || author.studentName || null;
};

/**
 * The photo URL a populated author document carries, across both collections.
 *
 * `Student.studentImage` is the uploaded photo; `User.avatar` is the equivalent.
 * There is no shared field, which is the same mismatch that broke the name.
 */
export const authorAvatarFrom = (author) => {
  if (!author || typeof author !== "object") return null;
  return author.studentImage || author.avatar || null;
};

/**
 * Fills a display name on a lean row from its populated author.
 *
 * Only used as a safety net for rows written before `authorModel` existed (and
 * for any future write path that forgets the snapshot) - the stored `authorName`
 * always wins, so this never rewrites history.
 */
export const withResolvedAuthorName = (doc) => {
  if (!doc || doc.authorName) return doc;

  const resolved = authorDisplayNameFrom(doc.authorId);
  return resolved ? { ...doc, authorName: resolved } : doc;
};

/**
 * Fills both the display name and the photo URL on a lean row.
 *
 * ## Why the avatar is not snapshotted
 *
 * The name is stored on the row so the feed never has to join for it. The photo is
 * deliberately not: a snapshot of an image URL keeps pointing at the old file after
 * a student changes their picture, so every historical post would show a dead link.
 * The photo is resolved on read from the populated author, and the client falls back
 * to initials when it is absent.
 *
 * Unlike `withResolvedAuthorName`, this never returns early on a row that already
 * has a name: the name may be perfectly good while the avatar is still missing, and
 * an early return would leave every legacy row without one.
 */
export const withResolvedAuthor = (doc) => {
  if (!doc) return doc;

  const author = doc.authorId;
  if (!author || typeof author !== "object") return doc;

  const name = doc.authorName || authorDisplayNameFrom(author) || null;
  const avatar = authorAvatarFrom(author);

  if (name === doc.authorName && avatar === doc.authorAvatar) return doc;

  return { ...doc, authorName: name, authorAvatar: avatar };
};