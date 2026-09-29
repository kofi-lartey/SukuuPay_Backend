// ─────────────────────────────────────────────
// HTML → plain text
// ─────────────────────────────────────────────
// Every message must carry a plain-text alternative alongside its HTML. The
// templates in src/templates/emails.js author HTML only, so this derives the
// text part from it rather than making every call site maintain two copies of
// the same content. A caller that supplies its own `text` bypasses this.

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&#39;': "'",
  '&pound;': '£',
  '&copy;': '©',
  '&reg;': '®',
};

// Elements that should force a line break in the text rendering.
const BLOCK_ELEMENTS = [
  'p', 'div', 'tr', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'section', 'article', 'header', 'footer', 'ul', 'ol',
];

const escapeForRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const decodeEntities = (input = '') =>
  Object.entries(ENTITIES).reduce(
    (text, [entity, char]) => text.split(entity).join(char),
    String(input)
  )
    // Numeric entities, decimal and hex.
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));

/**
 * Renders an HTML fragment as readable plain text.
 * Block-level elements become blank-line separated blocks, <br> becomes a
 * single newline, and table rows are flattened with " | " between cells so a
 * statement still reads as a statement.
 */
export const htmlToText = (html = '') => {
  if (!html) return '';

  let text = String(html);

  // Non-breaking spaces first, so they are not eaten by whitespace collapsing.
  text = text.split('&nbsp;').join(' ');

  // Drop content that should never reach a plain-text reader.
  text = text.replace(/<head[\s\S]*?<\/head>/gi, '');
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '');
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '');
  text = text.replace(/<!--[\s\S]*?-->/g, '');

  // <br> and </td> are single separators; </tr> and block ends are paragraph ends.
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/td>/gi, ' | ');
  text = text.replace(/<\/th>/gi, ' | ');

  BLOCK_ELEMENTS.forEach((tag) => {
    const open = new RegExp(`<${escapeForRegex(tag)}(\\s[^>]*)?>`, 'gi');
    const close = new RegExp(`</${escapeForRegex(tag)}>`, 'gi');
    text = text.replace(open, '\n\n').replace(close, '\n\n');
  });

  // Anything left is a tag.
  text = text.replace(/<[^>]+>/g, '');

  text = decodeEntities(text);

  // Collapse runs of spaces/tabs, then cap blank lines at two.
  text = text.replace(/[ \t]+/g, ' ');
  text = text
    .split('\n')
    .map((line) => line.trim())
    .join('\n');
  text = text.replace(/(\n\s*){3,}/g, '\n\n');
  // Trailing separators left by block tags read as noise.
  text = text.replace(/(\n \|)+\n/g, '\n');
  text = text.replace(/^[ \t]*\|[ \t]*/gm, '');

  return text.trim();
};

export default htmlToText;
