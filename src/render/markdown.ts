/**
 * Markdown to HTML for published pages.
 *
 * Deliberately the same subset the editor renders (see the frontend's markdown.tsx)
 * rather than a full CommonMark implementation, so what a learner sees while writing
 * is what a reader gets. Raw HTML in the source is escaped, never passed through:
 * this text is user-authored and ends up on a domain we own.
 */

export interface RenderOptions {
  /** Rewrites a relative image src — uploads live on the API host or a CDN, not here. */
  resolveImage?: (src: string) => string;
  /** Turns a [[wikilink]] into an href, or returns null to render it as plain text. */
  resolveWikiLink?: (target: string) => string | null;
}

/**
 * Takes `unknown`, not `string`, on purpose. Postgres hands back `timestamptz`
 * as a Date object while the row types say `string`, and a published page must
 * never 500 because a value was not the type its type claimed.
 */
export function escapeHtml(value: unknown): string {
  const s =
    typeof value === 'string'
      ? value
      : value instanceof Date
        ? value.toISOString()
        : String(value ?? '');
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Only http(s) and our own relative paths; blocks javascript: and data: URLs. */
function safeUrl(url: string): string | null {
  const trimmed = url.trim();
  if (/^(https?:)?\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith('/')) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return null;
  return trimmed;
}

/* ------------------------------------------------------------------- inline */

type Rule = {
  re: RegExp;
  render: (m: RegExpExecArray, o: RenderOptions) => string;
};

const RULES: Rule[] = [
  { re: /`([^`]+)`/, render: (m) => `<code>${escapeHtml(m[1])}</code>` },
  { re: /\*\*([^*]+)\*\*/, render: (m, o) => `<strong>${inline(m[1], o)}</strong>` },
  { re: /(?<![*\w])\*([^*\n]+)\*(?!\*)/, render: (m, o) => `<em>${inline(m[1], o)}</em>` },
  { re: /_([^_\n]+)_/, render: (m, o) => `<em>${inline(m[1], o)}</em>` },
  { re: /~~([^~]+)~~/, render: (m, o) => `<del>${inline(m[1], o)}</del>` },
  {
    re: /\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/,
    render: (m, o) => {
      const target = m[1].trim();
      const label = escapeHtml((m[2] ?? m[1]).trim());
      const href = o.resolveWikiLink?.(target) ?? null;
      return href
        ? `<a class="wikilink" href="${escapeHtml(href)}">${label}</a>`
        : `<span class="wikilink dead">${label}</span>`;
    },
  },
  {
    re: /!\[([^\]]*)\]\(([^)\s]+)\)/,
    render: (m, o) => {
      const url = safeUrl(m[2]);
      if (!url) return escapeHtml(m[0]);
      const src = o.resolveImage ? o.resolveImage(url) : url;
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(m[1])}" loading="lazy" decoding="async">`;
    },
  },
  {
    re: /\[([^\]]+)\]\(([^)\s]+)\)/,
    render: (m, o) => {
      const url = safeUrl(m[2]);
      if (!url) return inline(m[1], o);
      return `<a href="${escapeHtml(url)}" rel="noopener nofollow ugc">${inline(m[1], o)}</a>`;
    },
  },
  {
    re: /(https?:\/\/[^\s<>]+[^\s<>.,;:!?)])/,
    render: (m) =>
      `<a href="${escapeHtml(m[1])}" rel="noopener nofollow ugc">${escapeHtml(m[1])}</a>`,
  },
];

/** Leftmost match wins, so `**bold**` beats the `*italic*` inside it. */
function inline(text: string, o: RenderOptions): string {
  if (!text) return '';
  let best: { index: number; match: RegExpExecArray; rule: Rule } | null = null;
  for (const rule of RULES) {
    const m = new RegExp(rule.re.source, rule.re.flags.replace('g', '')).exec(text);
    if (m && (best === null || m.index < best.index)) best = { index: m.index, match: m, rule };
  }
  if (!best) return escapeHtml(text);
  const { index, match, rule } = best;
  return (
    escapeHtml(text.slice(0, index)) +
    rule.render(match, o) +
    inline(text.slice(index + match[0].length), o)
  );
}

/* -------------------------------------------------------------------- block */

const BLOCK_START = /^(#{1,6}\s|>\s?|```|\s*([-*+]|\d+[.)])\s+|(-{3,}|\*{3,}|_{3,})\s*$)/;

export function renderMarkdown(source: string | null | undefined, o: RenderOptions = {}): string {
  if (!source?.trim()) return '';
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      i++;
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) body.push(lines[i++]);
      i++;
      const lang = fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(body.join('\n'))}</code></pre>`);
      continue;
    }

    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      // Shifted down two: the page's own <h1> and <h2> are the book and question.
      const level = Math.min(heading[1].length + 2, 6);
      out.push(`<h${level}>${inline(heading[2], o)}</h${level}>`);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote>${renderMarkdown(body.join('\n'), o)}</blockquote>`);
      continue;
    }

    if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
        const raw = lines[i++];
        const indent = Math.min(Math.floor((/^\s*/.exec(raw)?.[0].length ?? 0) / 2), 6);
        const body = inline(raw.replace(/^\s*([-*+]|\d+[.)])\s+/, ''), o);
        items.push(
          indent
            ? `<li style="margin-left:${indent * 16}px">${body}</li>`
            : `<li>${body}</li>`,
        );
      }
      const tag = ordered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !BLOCK_START.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join('\n'), o)}</p>`);
  }

  return out.join('\n');
}

/** First ~200 characters of prose, for the meta description and OG card. */
export function excerpt(source: string | null | undefined, limit = 200): string {
  if (!source) return '';
  const flat = source
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]*))?\]\]/g, (_m, a, b) => b || a)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (flat.length <= limit) return flat;
  return flat.slice(0, flat.lastIndexOf(' ', limit) || limit).trimEnd() + '…';
}
