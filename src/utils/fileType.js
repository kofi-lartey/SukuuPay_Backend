/**
 * Identifies a file by its leading bytes rather than its declared MIME type.
 *
 * `file.mimetype` is whatever the browser put in the multipart header, and it is
 * client-controlled: a `.exe` renamed to `.png` arrives as `image/png`. Every
 * upload route in this codebase that checks `mimetype` is therefore checking a
 * claim, not a fact — which is tolerable for an avatar the school uploaded
 * itself and is not tolerable for a file that will be served back to other
 * students.
 *
 * ## Why `family` exists
 *
 * A recording made in a browser arrives as a `Blob` whose container the server
 * cannot infer from its name, and the same container legitimately carries both
 * audio and video: WebM is `audio/webm` for a voice note and `video/webm` for a
 * clip, with identical leading bytes. Comparing the declared type against a
 * single sniffed string therefore rejects valid voice notes.
 *
 * So each signature also reports a `family` — the container — and
 * `agreesWithDeclared` accepts a declared type whose subtype is in that family.
 * The bytes still decide the container; the declared type only says which track
 * inside it is wanted.
 */

const SIGNATURES = [
  { mime: "image/jpeg", ext: "jpg", family: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/png", ext: "png", family: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: "image/gif", ext: "gif", family: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: "application/pdf", ext: "pdf", family: "pdf", bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: "application/zip", ext: "zip", family: "zip", bytes: [0x50, 0x4b, 0x03, 0x04] },
  // EBML — WebM and MKV. The container is the same; only the codec differs, and
  // the client's declared type says which one it recorded.
  { mime: "video/webm", ext: "webm", family: "webm", bytes: [0x1a, 0x45, 0xdf, 0xa3] },
  { mime: "audio/ogg", ext: "ogg", family: "ogg", bytes: [0x4f, 0x67, 0x67, 0x53] },
  // "ID3" tag, or a bare MPEG frame sync.
  { mime: "audio/mpeg", ext: "mp3", family: "mpeg", bytes: [0x49, 0x44, 0x33] },
  // AAC in an ADTS stream.
  { mime: "audio/aac", ext: "aac", family: "aac", bytes: [0xff, 0xf1] },
];

/** RIFF containers need the subtype at offset 8 to be told apart. */
const RIFF_SUBTYPES = {
  WEBP: { mime: "image/webp", ext: "webp", family: "webp" },
  WAVE: { mime: "audio/wav", ext: "wav", family: "wav" },
  AVI: { mime: "video/x-msvideo", ext: "avi", family: "avi" },
};

const startsWith = (buffer, bytes) => bytes.every((byte, index) => buffer[index] === byte);

/** A bare MPEG audio frame sync: 11 set bits, i.e. `0xFF` then `0xEx`. */
const isMpegFrameSync = (buffer) => buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;

/**
 * @param {Buffer} buffer the uploaded bytes
 * @returns {{ mime: string, ext: string, family: string } | null} null when unrecognised
 */
export const sniffMime = (buffer) => {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return null;

  // ISO base-media (MP4 / MOV / M4A) carries a `ftyp` box at offset 4.
  if (buffer[4] === 0x66 && buffer[5] === 0x74 && buffer[6] === 0x79 && buffer[7] === 0x70) {
    return { mime: "video/mp4", ext: "mp4", family: "mp4" };
  }

  for (const signature of SIGNATURES) {
    if (startsWith(buffer, signature.bytes)) {
      return { mime: signature.mime, ext: signature.ext, family: signature.family };
    }
  }

  if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46])) {
    const subtype = buffer.subarray(8, 12).toString("ascii").toUpperCase();
    const match = RIFF_SUBTYPES[subtype];
    if (match) return match;
  }

  if (isMpegFrameSync(buffer)) {
    return { mime: "audio/mpeg", ext: "mp3", family: "mpeg" };
  }

  return null;
};

/**
 * Whether a declared type agrees with the sniffed one.
 *
 * A disagreement is a rejection, not a correction: if the bytes say PNG and the
 * header says PDF, the request was either built by a broken client or by one
 * trying something, and neither should be handed a Cloudinary URL.
 *
 * `application/octet-stream` is accepted, because that is what curl and some
 * server-side HTTP clients send when they have no better answer — the bytes
 * still decide what it is.
 */
export const agreesWithDeclared = (declared, sniffed) => {
  if (!declared || !sniffed) return true;
  if (declared === "application/octet-stream") return true;

  const normalised = declared.split(";")[0].trim().toLowerCase();
  if (normalised === sniffed.mime) return true;

  // Same container, different track: `audio/webm` against `video/webm`.
  const subtype = normalised.split("/")[1];
  return Boolean(subtype) && subtype === sniffed.family;
};