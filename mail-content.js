export function htmlToText(html) {
  const namedEntities = {
    amp: "&",
    apos: "'",
    bull: "\u2022",
    copy: "\u00a9",
    gt: ">",
    hellip: "\u2026",
    ldquo: "\u201c",
    lsquo: "\u2018",
    lt: "<",
    mdash: "\u2014",
    nbsp: " ",
    ndash: "\u2013",
    quot: "\"",
    rdquo: "\u201d",
    rsquo: "\u2019"
  };
  return String(html)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|head|title|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:address|article|aside|blockquote|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|li|main|nav|ol|p|section|table|tr|ul)\s*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;|&#160;|&#x0*a0;/gi, " ")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&apos;|&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);?/gi, (match, value) => {
      const codePoint = Number.parseInt(value, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&#(\d+);?/g, (match, value) => {
      const codePoint = Number.parseInt(value, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    })
    .replace(/&([a-z][a-z0-9]+);/gi, (match, name) => namedEntities[name.toLowerCase()] ?? match)
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
