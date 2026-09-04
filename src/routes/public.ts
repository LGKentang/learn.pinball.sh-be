/**
 * The published web: <handle>.pinball.sh.
 *
 * Every route here is unauthenticated and every query it makes requires
 * `published_at IS NOT NULL`. Nothing in this file consults req.user — a published
 * page renders identically for its author and for a stranger, which is the only
 * way to be sure a draft never leaks through a cache.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env, HANDLE_RE } from '../env.js';
import { publicBook, publicBooks, publicProfile, publicTree } from '../db/users.js';
import { imageUrl } from '../storage.js';
import { excerpt, escapeHtml, renderMarkdown } from '../render/markdown.js';
import { page } from '../render/page.js';

/**
 * The handle is whatever single label sits in front of the base domain. Cloudflare
 * proxies these, so Host is what we get; a wildcard certificate only covers one
 * label deep, which is why there is no <book>.<handle> form.
 */
export function handleFromHost(hostHeader: string | undefined): string | null {
  if (!hostHeader) return null;
  const host = hostHeader.toLowerCase().split(':')[0].replace(/\.$/, '');
  if (host === env.appHost) return null;

  const suffix = `.${env.baseDomain}`;
  if (!host.endsWith(suffix)) {
    // Local development: alice.localhost resolves without any DNS setup.
    const local = /^([a-z0-9][a-z0-9-]{1,30}[a-z0-9])\.localhost$/.exec(host);
    return local ? local[1] : null;
  }
  const label = host.slice(0, -suffix.length);
  // Same shape a handle was validated against at claim time (env.ts HANDLE_RE) — a
  // label that could never have been claimed can only ever miss in publicProfile,
  // but there is no reason to let anything past this that is not even shaped right.
  return HANDLE_RE.test(label) ? label : null;
}

/** Same reason as escapeHtml: timestamptz arrives as a Date, not a string. */
const dateLabel = (value: string | Date | null | undefined): string => {
  if (!value) return '';
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
};

function shell(
  handle: string,
  profile: { name: string | null; avatar_url: string | null },
  body: string,
): string {
  const siteUrl = `https://${handle}.${env.baseDomain}`;
  const who = escapeHtml(profile.name ?? handle);
  const avatar = profile.avatar_url
    ? `<img src="${escapeHtml(profile.avatar_url)}" alt="" width="30" height="30" referrerpolicy="no-referrer">`
    : '';
  return `<header class="site"><div class="wrap">
  <div class="who">${avatar}<a href="${escapeHtml(siteUrl)}/">${who}</a></div>
  <div class="by">${escapeHtml(handle)}.${escapeHtml(env.baseDomain)}</div>
</div></header>
<div class="wrap">
${body}
<footer class="site">
  <div><span class="ball"></span>Published with <a href="${escapeHtml(env.appOrigin)}">Pinball Learn</a></div>
  <div>Questions, not notes.</div>
</footer>
</div>`;
}

/**
 * Progressive enhancement for the book layout's view toggle: without this running
 * (JS off or blocked), the page is exactly the old single-scroll article list —
 * the toggle is simply invisible (see `.js .view-toggle` in page.ts) and every
 * table-of-contents link still jumps to its section via a plain #anchor.
 */
const bookLayoutScript = `<script>(function(){
  var root = document.querySelector('.book-layout');
  if (!root) return;
  var toggle = root.querySelector('.view-toggle');
  var articles = Array.prototype.slice.call(root.querySelectorAll('.book-content > article'));
  var links = Array.prototype.slice.call(root.querySelectorAll('.toc a'));
  var KEY = 'pinball:bookViewMode';

  function currentArticle() {
    var byHash = articles.filter(function(a){ return '#' + a.id === location.hash; })[0];
    return byHash || articles[0];
  }

  function showCurrent() {
    var cur = currentArticle();
    articles.forEach(function(a){ a.classList.toggle('current', a === cur); });
    links.forEach(function(l){ l.classList.toggle('on', l.getAttribute('href') === '#' + cur.id); });
  }

  function applyMode(mode) {
    root.classList.toggle('segmented', mode === 'segment');
    Array.prototype.forEach.call(toggle.querySelectorAll('button'), function(b){
      b.classList.toggle('on', b.dataset.mode === mode);
    });
    try { localStorage.setItem(KEY, mode); } catch (e) {}
    if (mode === 'segment') showCurrent();
  }

  toggle.addEventListener('click', function(e){
    var btn = e.target.closest('button[data-mode]');
    if (btn) applyMode(btn.dataset.mode);
  });
  window.addEventListener('hashchange', function(){
    if (root.classList.contains('segmented')) showCurrent();
  });

  var saved = null;
  try { saved = localStorage.getItem(KEY); } catch (e) {}
  applyMode(saved === 'segment' ? 'segment' : 'all');
})();</script>`;

function notFound(reply: FastifyReply, handle: string | null, message: string) {
  const body = `<h1>Nothing here</h1><p class="intent">${escapeHtml(message)}</p>`;
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .send(
      page(
        {
          title: 'Not found',
          description: message,
          canonical: '',
          siteName: handle ? `${handle}.${env.baseDomain}` : env.baseDomain,
          siteUrl: '',
          index: false,
        },
        `<div class="wrap">${body}</div>`,
      ),
    );
}

export async function publicSite(app: FastifyInstance) {
  /**
   * Published pages are immutable enough to cache at the edge but must not be
   * cached per-viewer: they carry no session and no personalisation.
   */
  const cacheable = (reply: FastifyReply) =>
    reply
      .header('cache-control', 'public, max-age=60, stale-while-revalidate=600')
      .header('x-content-type-options', 'nosniff')
      .header('referrer-policy', 'strict-origin-when-cross-origin')
      .type('text/html; charset=utf-8');

  /** The profile: everything this person has chosen to publish. */
  app.get('/', async (req: FastifyRequest, reply) => {
    const handle = handleFromHost(req.headers.host);
    if (!handle) return notFound(reply, null, 'That address does not belong to anyone yet.');

    const profile = await publicProfile(handle);
    if (!profile) return notFound(reply, handle, 'No one has claimed this address.');

    const books = await publicBooks(handle);
    const siteUrl = `https://${handle}.${env.baseDomain}`;
    const name = profile.name ?? handle;

    const list = books.length
      ? `<ul class="books">${books
          .map(
            (b) => `<li><a class="card" href="/${escapeHtml(b.slug)}">
        <h2>${escapeHtml(b.title)}</h2>
        ${b.intent ? `<p>${escapeHtml(b.intent)}</p>` : ''}
        <p class="meta" style="margin-top:.5rem">${b.question_count} question${b.question_count === 1 ? '' : 's'} · updated ${escapeHtml(dateLabel(b.updated_at))}</p>
      </a></li>`,
          )
          .join('')}</ul>`
      : `<div class="empty">Nothing published yet.</div>`;

    const body = `<h1>${escapeHtml(name)}</h1>
${profile.bio ? `<p class="bio">${escapeHtml(profile.bio)}</p>` : ''}
<p class="meta">${books.length} published book${books.length === 1 ? '' : 's'}</p>
${list}`;

    return cacheable(reply).send(
      page(
        {
          title: `${name} — Pinball Learn`,
          description: profile.bio ?? `What ${name} is working to understand.`,
          canonical: `${siteUrl}/`,
          siteName: `${handle}.${env.baseDomain}`,
          siteUrl,
          index: books.length > 0,
        },
        shell(handle, profile, body),
      ),
    );
  });

  /** One published book: its question tree, current answers only. */
  app.get('/:slug', async (req, reply) => {
    const handle = handleFromHost(req.headers.host);
    if (!handle) return notFound(reply, null, 'That address does not belong to anyone yet.');

    const { slug } = req.params as { slug: string };
    // Browsers ask for these against every host; answering with a 404 page is noise.
    if (slug === 'favicon.ico' || slug === 'robots.txt' || slug === 'sitemap.xml') {
      if (slug === 'robots.txt')
        return reply
          .type('text/plain; charset=utf-8')
          .send(`User-agent: *\nAllow: /\nSitemap: https://${handle}.${env.baseDomain}/sitemap.xml\n`);
      if (slug === 'sitemap.xml') {
        const books = await publicBooks(handle);
        const base = `https://${handle}.${env.baseDomain}`;
        const urls = [`<url><loc>${base}/</loc></url>`]
          .concat(
            books.map(
              (b) =>
                `<url><loc>${base}/${escapeHtml(b.slug)}</loc><lastmod>${new Date(b.updated_at).toISOString()}</lastmod></url>`,
            ),
          )
          .join('');
        return reply
          .type('application/xml; charset=utf-8')
          .send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
      }
      return reply.code(404).send();
    }

    const profile = await publicProfile(handle);
    if (!profile) return notFound(reply, handle, 'No one has claimed this address.');

    const book = await publicBook(handle, slug);
    if (!book) return notFound(reply, handle, 'That book is not published.');

    const tree = await publicTree(book.id);
    const ids = new Map(tree.map((n) => [n.title.toLowerCase(), n.id]));

    const md = {
      resolveImage: (src: string) => imageUrl(src),
      // A [[link]] only resolves if its target is also on this page; anything else
      // points into private notes and stays plain text.
      resolveWikiLink: (target: string) => {
        const id = ids.get(target.trim().toLowerCase());
        return id ? `#q-${id}` : null;
      },
    };

    const articles = tree
      .map(
        (n, idx) => `<article class="d${Math.min(n.depth + 1, 6)}" id="q-${escapeHtml(n.id)}">
  <h2><span class="q">${String(idx + 1).padStart(2, '0')}</span><span>${escapeHtml(n.title)}</span></h2>
  <div class="body">${renderMarkdown(n.understanding, md)}</div>
</article>`,
      )
      .join('\n');

    // A sidebar table of contents, mirroring the same depth the articles use, plus
    // an "all sections / one at a time" toggle. The toggle is pure enhancement
    // (see bookLayoutScript): every link here is a plain #q-<id> anchor, so jumping
    // to a section works with JavaScript off too — it just leaves every other
    // section on the page instead of hiding them.
    const toc = tree
      .map(
        (n) =>
          `<li class="d${Math.min(n.depth + 1, 6)}"><a href="#q-${escapeHtml(n.id)}">${escapeHtml(n.title)}</a></li>`,
      )
      .join('\n');

    const siteUrl = `https://${handle}.${env.baseDomain}`;
    const description =
      book.intent ?? excerpt(tree[0]?.understanding) ?? `${book.title} — a Pinball Learn book.`;

    const main = tree.length
      ? `<div class="book-layout">
  <nav class="toc" aria-label="Sections">
    <div class="toc-head">
      <span>Sections</span>
      <div class="view-toggle" role="group" aria-label="View mode">
        <button type="button" class="on" data-mode="all">All</button>
        <button type="button" data-mode="segment">By section</button>
      </div>
    </div>
    <ol>${toc}</ol>
  </nav>
  <div class="book-content">
${articles}
  </div>
</div>
${bookLayoutScript}`
      : '<div class="empty">This book has no answered questions yet.</div>';

    const body = `<p class="meta">${escapeHtml(profile.name ?? handle)} · published ${escapeHtml(dateLabel(book.published_at))}</p>
<h1>${escapeHtml(book.title)}</h1>
${book.intent ? `<p class="intent">${escapeHtml(book.intent)}</p>` : ''}
${main}`;

    return cacheable(reply).send(
      page(
        {
          title: `${book.title} — ${profile.name ?? handle}`,
          description,
          canonical: `${siteUrl}/${book.slug}`,
          siteName: `${handle}.${env.baseDomain}`,
          siteUrl,
          index: tree.length > 0,
          published: book.published_at,
          modified: book.updated_at,
        },
        shell(handle, profile, body),
      ),
    );
  });
}
