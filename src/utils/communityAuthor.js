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
 * Students are shown by first name — "Kwame", not "Kwame Mensah Jr" — which is
 * how a school refers to a child in a feed. Staff keep their full `name`, since
 * a `User` document carries no `firstName` and a teacher's full name is the
 * identifier a parent recognises.
 */
export const authorDisplayName = (user) => {
  if (!user) return null;
  return user.firstName || user.name || null;
};

/**
 * Fills a display name on a lean row from its populated author.
 *
 * Only used as a safety net for rows written before `authorModel` existed (and
 * for any future write path that forgets the snapshot) — the stored
 * `authorName` always wins, so this never rewrites history.
 */
export const withResolvedAuthorName = (doc) => {
  if (!doc || doc.authorName) return doc;

  const author = doc.authorId;
  const resolved =
    (typeof author === "object" && author
      ? author.firstName || author.name || author.studentName
      : null) || null;

  return resolved ? { ...doc, authorName: resolved } : doc;
};