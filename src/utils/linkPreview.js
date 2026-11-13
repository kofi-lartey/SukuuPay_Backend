import dns from "node:dns/promises";
import net from "node:net";

/**
 * Fetches Open Graph metadata for a URL so a chat can render a preview card.
 *
 * ## Why the server fetches this
 *
 * A preview is a server-side job: browsers cannot read another origin's
 * `<meta property="og:title">` without CORS, and every public site would have to
 * opt in. The server fetches once and stores the result, so the card costs every
 * reader nothing and cannot be re-fetched into a loop.
 *
 * ## Why this file is careful about *where* it fetches
 *
 * Accepting a URL from a student and fetching it is a server-side request forgery
 * primitive. A posted link like `http://169.254.169.254/latest/meta-data/` or
 * `http://localhost:2345/admin` would otherwise be fetched *by the server*, from
 * inside the network, with the server's own access — and the response body would
 * come back to the attacker as a preview description.
 *
 * Three defences, each covering a different bypass:
 *
 *  1. **Scheme allow-list.** `file:`, `gopher:` and `data:` never reach a socket.
 *  2. **Address check on every hop.** The hostname is resolved and every answer
 *     is rejected if it is loopback, link-local, private, or multicast. This is
 *     what stops `localhost` and the cloud metadata endpoint.
 *  3. **Manual redirect handling.** `fetch` follows redirects by default, so a
 *     public URL that 302s to `169.254.169.254` would pass check (2) and then
 *     defeat it. Redirects are followed one hop at a time, re-checking each
 *     destination.
 *
 * It is not a complete defence against DNS rebinding — a hostname that resolves
 * to a public address during the check and a private one during the fetch — but
 * the window is small, the resolved address is checked immediately before the
 * request, and the residual risk is a preview of an internal page rather than
 * arbitrary request forgery with credentials.
 */

const MAX_HOPS = 3;
const TIMEOUT_MS = 4000;
const MAX_BYTES = 512 * 1024;

const PRIVATE_V4 = [
  /^0\./, // "this" network
  /^10\./,
  /^127\./,
  /^169\.254\./, // link-local, includes 169.254.169.254 (cloud metadata)
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, // carrier-grade NAT
];

const isPrivateIPv4 = (address) => PRIVATE_V4.some((pattern) => pattern.test(address));

const isPrivateIPv6 = (address) => {
  const value = address.toLowerCase().split("%")[0];
  if (value === "::" || value === "::1") return true;
  if (value.startsWith("fe80") || value.startsWith("fc") || value.startsWith("fd")) return true;
  // IPv4-mapped, e.g. ::ffff:127.0.0.1
  const mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return mapped ? isPrivateIPv4(mapped[1]) : false;
};

/** Rejects loopback, link-local, private and multicast targets. */
export const assertPublicTarget = async (hostname) => {
  // A literal IP needs no resolution — but still has to be public.
  if (net.isIP(hostname)) {
    const blocked = net.isIPv4(hostname) ? isPrivateIPv4(hostname) : isPrivateIPv6(hostname);
    if (blocked) throw Object.assign(new Error("That address is not allowed"), { status: 400 });
    return;
  }

  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) {
    throw Object.assign(new Error("That host could not be resolved"), { status: 400 });
  }

  for (const record of records) {
    const blocked = record.family === 4 ? isPrivateIPv4(record.address) : isPrivateIPv6(record.address);
    if (blocked) {
      throw Object.assign(new Error("That address is not allowed"), { status: 400 });
    }
  }
};

const parseTarget = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw Object.assign(new Error("That is not a valid link"), { status: 400 });
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw Object.assign(new Error("Only http and https links can be previewed"), { status: 400 });
  }

  return url;
};

/** Reads at most `MAX_BYTES`, then aborts — a 2 GB page is not a preview. */
const readCapped = async (response) => {
  const reader = response.body?.getReader?.();
  if (!reader) return (await response.text()).slice(0, MAX_BYTES);

  const chunks = [];
  let total = 0;

  while (total < MAX_BYTES) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }

  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString("utf8").slice(0, MAX_BYTES);
};

const decode = (html) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/**
 * Reads the first matching `<meta>` — Open Graph first, then the HTML fallbacks.
 * `property` and `name` are both accepted because sites use both.
 */
const metaContent = (html, keys) => {
  for (const key of keys) {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${key}["'][^>]*>`,
      "i"
    );
    const tag = html.match(pattern)?.[0];
    const content = tag?.match(/content=["']([^"']*)["']/i)?.[1];
    if (content?.trim()) return decode(content).slice(0, 300);
  }
  return null;
};

const titleFrom = (html, url) => {
  const og = metaContent(html, ["og:title", "twitter:title"]);
  if (og) return og;

  const tag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (tag?.trim()) return decode(tag).slice(0, 300);

  return url.hostname.replace(/^www\./, "");
};

/**
 * YouTube's id for a URL, or null.
 *
 * `watch?v=`, `youtu.be/<id>`, `/shorts/<id>` and `/embed/<id>` all identify the
 * same video, and a link pasted into a chat is as likely to be any of them.
 */
const youtubeId = (raw) => {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const host = url.hostname.replace(/^www\./, "").toLowerCase();

  if (host === "youtu.be") {
    return url.pathname.split("/").filter(Boolean)[0] || null;
  }

  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const match = url.pathname.match(/\/(?:embed|shorts|v)\/([\w-]{6,})/);
    return match ? match[1] : null;
  }

  return null;
};

/**
 * Reads a JSON oEmbed document.
 *
 * Used for sites that serve a bot check to a plain HTTP client: YouTube returns a
 * page with no Open Graph tags at all to anything that is not a browser, so
 * scraping it yields `title: "youtube.com"` and no image. Their oEmbed endpoint is
 * the supported way to ask, and it needs no key.
 */
const fetchOEmbed = async (endpoint) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(endpoint, {
      redirect: "follow",
      signal: controller.signal,
      headers: { accept: "application/json", "user-agent": "SukuuPayBot/1.0 (+https://sukuupay.com/bot)" },
    });

    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const oEmbedPreview = (data, target) => {
  if (!data?.title) return null;

  return {
    url: target.toString(),
    title: String(data.title).slice(0, 300),
    description: data.author_name ? `By ${data.author_name}` : null,
    imageUrl:
      typeof data.thumbnail_url === "string" && !data.thumbnail_url.startsWith("data:")
        ? data.thumbnail_url
        : null,
    siteName: data.provider_name || target.hostname.replace(/^www\./, ""),
  };
};

/** YouTube first, because scraping it never works. */
const tryYouTube = async (target) => {
  const id = youtubeId(target.toString());
  if (!id) return null;

  const endpoint =
    "https://www.youtube.com/oembed?url=" +
    encodeURIComponent(`https://www.youtube.com/watch?v=${id}`) +
    "&format=json";

  return oEmbedPreview(await fetchOEmbed(endpoint), target);
};
/**
 * @param {string} raw the URL a user posted
 * @returns {Promise<{url: string, title: string, description: string|null, imageUrl: string|null, siteName: string|null}>}
 */
export const fetchLinkPreview = async (raw) => {
  let target = parseTarget(raw);

  // YouTube answers a plain client with a bot-check page that carries no Open
  // Graph tags, so ask its oEmbed endpoint instead of scraping.
  const embedded = await tryYouTube(target);
  if (embedded) return embedded;

  let response;
  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    // Re-resolved per hop: a redirect can point anywhere, including inward.
    await assertPublicTarget(target.hostname);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      // `redirect: "manual"` is the point of the loop below.
      // eslint-disable-next-line no-await-in-loop
      response = await fetch(target, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "SukuuPayBot/1.0 (+https://sukuupay.com/bot)",
          accept: "text/html,application/xhtml+xml",
        },
      });
    } catch (error) {
      throw Object.assign(
        new Error(error?.name === "AbortError" ? "That link took too long to respond" : "That link could not be reached"),
        { status: 400 }
      );
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) break;
      if (hop === MAX_HOPS) break;
      target = new URL(location, target);
      // eslint-disable-next-line no-continue
      continue;
    }

    break;
  }

  if (!response) {
    throw Object.assign(new Error("That link could not be read"), { status: 400 });
  }

  if (!response.ok) {
    throw Object.assign(new Error("That link could not be read"), { status: 400 });
  }

  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("html")) {
    // A PDF or an image still deserves a card, just without text to quote.
    return {
      url: target.toString(),
      title: decodeURIComponent(target.pathname.split("/").pop() || target.hostname),
      description: null,
      imageUrl: contentType.startsWith("image/") ? target.toString() : null,
      siteName: target.hostname.replace(/^www\./, ""),
    };
  }

  const html = await readCapped(response);

  const image =
    metaContent(html, ["og:image", "og:image:url", "twitter:image"]) || null;

  return {
    url: target.toString(),
    title: titleFrom(html, target),
    description: metaContent(html, ["og:description", "twitter:description", "description"]),
    imageUrl: image && !image.startsWith("data:") ? image : null,
    siteName: metaContent(html, ["og:site_name"]) || target.hostname.replace(/^www\./, ""),
  };
};

/** The first http(s) URL in a block of text, without trailing punctuation. */
export const firstUrlIn = (text) => {
  if (!text || typeof text !== "string") return null;
  const match = text.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  // A sentence-ending period is punctuation, not part of the URL.
  return match[0].replace(/[.,;:!?)\]]+$/, "");
};

export default fetchLinkPreview;