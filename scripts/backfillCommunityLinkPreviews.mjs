// Re-derives link previews that were stored as failures.
//
//   node scripts/backfillCommunityLinkPreviews.mjs            dry run — reports, changes nothing
//   node scripts/backfillCommunityLinkPreviews.mjs --apply    applies it
//
// ## Why a stored preview can be a failure
//
// `createComment` resolves the preview server-side at post time. Some sites answer
// a plain HTTP client with a bot check that carries no Open Graph tags, and the
// fallback then stores the *hostname* as the title — `title: "youtube.com"`, no
// image, no description. The card renders, but it is a link to a site rather than
// a preview of a video.
//
// The rule for spotting one is exact: the stored title equals the hostname the URL
// points at. That is only ever the last-resort fallback, never a real page title,
// so it is safe to select on.
//
// Only `linkPreview` is written. Body, author and school are untouched.
import mongoose from 'mongoose';
import { MONGODB_URI } from '../src/config/env.js';
import { fetchLinkPreview, firstUrlIn } from '../src/utils/linkPreview.js';

const APPLY = process.argv.includes('--apply');

await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
const db = mongoose.connection.db;

console.log(`\nCommunity link previews — ${MONGODB_URI.replace(/:\/\/([^:]+):([^@]+)@/, '://$1:***@')}`);
console.log(APPLY ? 'mode: APPLY\n' : 'mode: dry run (pass --apply to write)\n');

const rows = await db
  .collection('communitycomments')
  .find({ 'linkPreview.url': { $exists: true, $ne: null }, isDeleted: false })
  .project({ body: 1, linkPreview: 1 })
  .toArray();

let updated = 0;
let skipped = 0;

for (const row of rows) {
  const preview = row.linkPreview;
  const url = preview?.url || firstUrlIn(row.body);
  if (!url) continue;

  let host;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    continue;
  }

  const looksFailed = !preview?.title || preview.title === host || preview.title === `www.${host}`;
  if (!looksFailed) continue;

  // eslint-disable-next-line no-await-in-loop
  const fresh = await fetchLinkPreview(url);

  if (!fresh || !fresh.title || fresh.title === host) {
    skipped += 1;
    console.log(`  ! ${String(row._id)} — still unresolvable (${host}), left alone`);
    continue;
  }

  console.log(`  ${String(row._id)}`);
  console.log(`      ${JSON.stringify(preview?.title)} -> ${JSON.stringify(fresh.title)}`);
  console.log(`      image: ${fresh.imageUrl ? 'yes' : 'none'}`);

  if (APPLY) {
    // eslint-disable-next-line no-await-in-loop
    await db
      .collection('communitycomments')
      .updateOne({ _id: row._id }, { $set: { linkPreview: fresh } });
  }
  updated += 1;
}

if (skipped > 0) console.log(`\n${skipped} row(s) could not be improved`);
console.log(APPLY ? `\nUpdated ${updated} row(s)` : `\nDry run: ${updated} row(s) would be updated`);

await mongoose.disconnect();