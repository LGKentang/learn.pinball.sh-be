/**
 * The HTML shell for published pages.
 *
 * Self-contained on purpose: one document, inline CSS, no build step. A published
 * site is somebody's writing on the open web — it should render on a slow
 * connection, in a reader mode, and long after the SPA has been rebuilt. The one
 * script here just flips a `js` class for progressive enhancement (see the book
 * page's table-of-contents toggle in routes/public.ts) — with it disabled or
 * blocked, every page still renders and reads exactly as it would otherwise.
 */
import { escapeHtml } from './markdown.js';

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  /** Shown as the site name in the header and OG card. */
  siteName: string;
  siteUrl: string;
  /** noindex for pages we do not want in search results (404s, empty profiles). */
  index?: boolean;
  /** Accepts what the database actually returns for timestamptz: a Date. */
  published?: string | Date | null;
  modified?: string | Date | null;
}

const CSS = `
:root{
  --bg:#0d0f14; --panel:#141821; --panel-2:#1a1f2b; --line:#262d3b;
  --text:#e6e9f0; --dim:#99a1b3; --dimmer:#7f8899; --accent:#ff6b4a;
  --blue:#5aa9ff; --green:#4ec9a0; --amber:#e2b352; --violet:#b18aff;
  --mono:ui-monospace,"SF Mono","Cascadia Mono",Menlo,Consolas,monospace;
  color-scheme:dark;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{
  margin:0; background:var(--bg); color:var(--text);
  font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  -webkit-font-smoothing:antialiased;
}
a{color:var(--blue); text-decoration:none}
a:hover{text-decoration:underline}
.wrap{max-width:44rem; margin:0 auto; padding:0 1.25rem 6rem}
header.site{
  border-bottom:1px solid var(--line); margin-bottom:2.5rem;
  padding:1.1rem 0; position:sticky; top:0; background:rgba(13,15,20,.86);
  backdrop-filter:blur(8px); z-index:5;
}
header.site .wrap{padding-bottom:0; display:flex; gap:.75rem; align-items:center; justify-content:space-between}
.who{display:flex; gap:.7rem; align-items:center; min-width:0}
.who img{width:30px; height:30px; border-radius:50%; flex:none}
.who a{color:var(--text); font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis}
.by{font-family:var(--mono); font-size:11px; color:var(--dimmer); letter-spacing:.06em; text-transform:uppercase}
h1{font-size:2rem; line-height:1.2; margin:.4rem 0 .5rem; letter-spacing:-.02em}
.intent{color:var(--dim); font-size:1.05rem; margin:0 0 2rem}
.bio{color:var(--dim); margin:.25rem 0 2rem}
.meta{font-family:var(--mono); font-size:11.5px; color:var(--dimmer); letter-spacing:.05em; text-transform:uppercase}
.books{list-style:none; padding:0; margin:1.5rem 0 0; display:grid; gap:.75rem}
.books li{border:1px solid var(--line); border-radius:10px; background:var(--panel)}
.books a.card{display:block; padding:1rem 1.15rem; color:inherit}
.books a.card:hover{border-color:var(--accent); text-decoration:none; background:var(--panel-2)}
.books h2{margin:0 0 .3rem; font-size:1.1rem}
.books p{margin:0; color:var(--dim); font-size:.94rem}
/* two-column layout for a book with a table of contents; :has() only widens the
   wrapper on pages that actually have one, so every other page is unaffected */
.wrap:has(.book-layout){max-width:64rem}
.book-layout{display:grid; grid-template-columns:15rem 1fr; gap:3rem; align-items:start}
.toc{position:sticky; top:5.5rem; font-size:.86rem; min-width:0}
.toc-head{display:flex; align-items:center; justify-content:space-between; gap:.5rem; margin-bottom:.7rem}
.toc-head>span{font-family:var(--mono); font-size:10.5px; letter-spacing:.08em; text-transform:uppercase; color:var(--dimmer)}
.view-toggle{display:flex; gap:2px; padding:2px; background:var(--panel); border:1px solid var(--line); border-radius:7px}
.view-toggle button{
  background:none; border:none; color:var(--dim); font-size:11px; padding:3px 8px;
  border-radius:5px; cursor:pointer; font-family:inherit;
}
.view-toggle button.on{background:var(--panel-2); color:var(--text)}
/* inert without JS (see the script at the end of a book page) — harmless, the
   page just stays in its default "all sections" reading view */
.view-toggle{visibility:hidden}
.js .view-toggle{visibility:visible}
.toc ol{list-style:none; margin:0; padding:0; display:grid; gap:.15rem}
.toc a{
  display:block; padding:.32rem .55rem; border-radius:6px; color:var(--dim);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap;
}
.toc a:hover{color:var(--text); text-decoration:none; background:var(--panel-2)}
.toc a.on{color:var(--accent); background:var(--panel-2)}
.toc li.d2 a,.toc li.d3 a{padding-left:1.15rem; font-size:.82rem}
.toc li.d4 a,.toc li.d5 a,.toc li.d6 a{padding-left:1.75rem; font-size:.8rem}
.book-content{min-width:0}
.book-layout.segmented .book-content>article{display:none}
.book-layout.segmented .book-content>article.current{display:block}
@media (max-width:900px){
  .book-layout{grid-template-columns:1fr}
  .toc{
    position:static; margin-bottom:2rem; border:1px solid var(--line); border-radius:10px;
    padding:1rem 1.1rem; background:var(--panel);
  }
}
article{border-top:1px solid var(--line); padding-top:2rem; margin-top:2rem}
article:first-of-type{border-top:0; margin-top:0}
article h2{
  font-size:1.3rem; line-height:1.3; margin:0 0 .75rem; letter-spacing:-.01em;
  display:flex; gap:.6rem; align-items:baseline;
}
article h2 .q{color:var(--accent); font-family:var(--mono); font-size:.8rem; flex:none; padding-top:.15rem}
article.d1{margin-left:0}
article.d2,article.d3,article.d4,article.d5,article.d6{
  border-top:0; border-left:2px solid var(--line); padding:.25rem 0 0 1.25rem; margin-top:1.75rem;
}
article.d2 h2,article.d3 h2{font-size:1.12rem}
article.d4 h2,article.d5 h2,article.d6 h2{font-size:1rem}
.body p{margin:0 0 1rem}
.body h3,.body h4,.body h5,.body h6{margin:1.6rem 0 .6rem; line-height:1.3}
.body ul,.body ol{margin:0 0 1rem; padding-left:1.35rem}
.body li{margin:.25rem 0}
.body img{max-width:100%; height:auto; border-radius:8px; border:1px solid var(--line); display:block; margin:1rem 0}
.body img{cursor:zoom-in}

/* lightbox */
.lb{position:fixed; inset:0; z-index:60; display:none; background:rgba(6,8,12,.93); -webkit-backdrop-filter:blur(5px); backdrop-filter:blur(5px)}
.lb.on{display:block}
.lb-stage{position:absolute; inset:0; overflow:hidden; display:grid; place-items:center; touch-action:none}
.lb-stage img{
  max-width:92vw; max-height:86vh; display:block; border-radius:6px;
  transform-origin:center center; will-change:transform; cursor:zoom-in;
  box-shadow:0 30px 90px rgba(0,0,0,.65); -webkit-user-select:none; user-select:none; -webkit-user-drag:none;
}
.lb.zoomed .lb-stage img{cursor:grab}
.lb.panning .lb-stage img{cursor:grabbing}
.lb-close{
  position:absolute; top:12px; right:14px; z-index:2; width:38px; height:38px; border-radius:50%;
  background:rgba(255,255,255,.08); border:1px solid var(--line); color:var(--text);
  font-size:17px; line-height:1; cursor:pointer;
}
.lb-close:hover{background:rgba(255,255,255,.16)}
.lb-bar{
  position:absolute; left:0; right:0; bottom:0; padding:14px 18px 18px; z-index:2;
  text-align:center; pointer-events:none;
  background:linear-gradient(180deg,transparent,rgba(6,8,12,.75));
}
.lb-cap{margin:0 0 4px; color:var(--text); font-size:13.5px; line-height:1.4}
.lb-hint{margin:0; color:var(--dimmer); font-family:var(--mono); font-size:11px; letter-spacing:.05em}
@media (max-width:640px){ .lb-hint{display:none} }
@media print{ .lb{display:none !important} }
.body code{
  font-family:var(--mono); font-size:.86em; background:var(--panel-2);
  border:1px solid var(--line); border-radius:4px; padding:.1em .35em;
}
.body pre{
  background:var(--panel); border:1px solid var(--line); border-radius:8px;
  padding:.9rem 1rem; overflow-x:auto; margin:0 0 1rem;
}
.body pre code{background:none; border:0; padding:0; font-size:.86rem; line-height:1.55}
.body blockquote{
  margin:0 0 1rem; padding:.1rem 0 .1rem 1rem; border-left:3px solid var(--line); color:var(--dim);
}
.body hr{border:0; border-top:1px solid var(--line); margin:1.75rem 0}
.wikilink{color:var(--violet)}
.wikilink.dead{color:var(--dimmer); border-bottom:1px dotted var(--dimmer)}
footer.site{
  border-top:1px solid var(--line); margin-top:4rem; padding-top:1.25rem;
  color:var(--dimmer); font-size:.86rem; display:flex; justify-content:space-between; gap:1rem; flex-wrap:wrap;
}
footer.site .ball{
  width:8px; height:8px; border-radius:50%; background:var(--accent);
  display:inline-block; vertical-align:middle; margin-right:.4rem; box-shadow:0 0 10px var(--accent);
}
.empty{color:var(--dim); border:1px dashed var(--line); border-radius:10px; padding:2rem; text-align:center}
@media (max-width:640px){ h1{font-size:1.6rem} .wrap{padding:0 1rem 4rem} }
@media print{ header.site{position:static; background:none} body{background:#fff; color:#111} }
`;

/** article:*_time wants ISO 8601, and an unparseable value is better omitted. */
function isoTime(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function page(meta: PageMeta, body: string): string {
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const published = isoTime(meta.published);
  const modified = isoTime(meta.modified);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<script>document.documentElement.classList.add('js')</script>
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${t}</title>
<meta name="description" content="${d}">
<link rel="canonical" href="${escapeHtml(meta.canonical)}">
${meta.index === false ? '<meta name="robots" content="noindex">' : '<meta name="robots" content="index, follow">'}
<meta property="og:type" content="article">
<meta property="og:title" content="${t}">
<meta property="og:description" content="${d}">
<meta property="og:url" content="${escapeHtml(meta.canonical)}">
<meta property="og:site_name" content="${escapeHtml(meta.siteName)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${t}">
<meta name="twitter:description" content="${d}">
${published ? `<meta property="article:published_time" content="${published}">` : ''}
${modified ? `<meta property="article:modified_time" content="${modified}">` : ''}
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='9' fill='%23ff6b4a'/%3E%3C/svg%3E">
<style>${CSS}</style>
</head>
<body>
${body}

<div class="lb" id="lb" role="dialog" aria-modal="true" aria-label="Image viewer" hidden>
  <button class="lb-close" type="button" aria-label="Close image">&#10005;</button>
  <div class="lb-stage"><img alt=""></div>
  <div class="lb-bar"><p class="lb-cap"></p><p class="lb-hint">scroll to zoom &middot; drag to pan &middot; double-click to reset &middot; esc to close</p></div>
</div>
<script>
/* Click an image to see it full size. Zoom with the wheel or a pinch, anchored on
   the pointer so whatever you are looking at stays under it; drag to pan.

   This is the only JavaScript on a published page and everything above it renders
   without it, which keeps the promise in D12 mostly intact: the page is readable
   with scripting off, it just is not zoomable. If a CSP is ever added in front of
   these pages, this block needs a nonce. */
(function () {
  var lb = document.getElementById('lb');
  if (!lb) return;
  var stage = lb.querySelector('.lb-stage');
  var pic = stage.querySelector('img');
  var cap = lb.querySelector('.lb-cap');
  var closeBtn = lb.querySelector('.lb-close');

  var MIN = 1, MAX = 8;
  var scale = 1, tx = 0, ty = 0;
  var opener = null;
  var pointers = new Map();
  var pinchFrom = 0, scaleFrom = 1, panFrom = null;

  function apply() {
    pic.style.transform = 'translate(' + tx + 'px,' + ty + 'px) scale(' + scale + ')';
    lb.classList.toggle('zoomed', scale > 1);
  }

  function reset() { scale = 1; tx = 0; ty = 0; apply(); }

  /* Keep the point under the cursor fixed while the scale changes, so zooming
     feels like moving toward what you pointed at rather than toward the middle. */
  function zoomAt(cx, cy, factor) {
    var next = Math.min(MAX, Math.max(MIN, scale * factor));
    if (next === scale) return;
    var r = stage.getBoundingClientRect();
    var px = cx - r.left - r.width / 2;
    var py = cy - r.top - r.height / 2;
    tx = px - (px - tx) * (next / scale);
    ty = py - (py - ty) * (next / scale);
    scale = next;
    if (scale === MIN) { tx = 0; ty = 0; }
    apply();
  }

  function open(src, alt) {
    opener = document.activeElement;
    pic.src = src;
    pic.alt = alt || '';
    cap.textContent = alt || '';
    cap.style.display = alt ? '' : 'none';
    reset();
    lb.hidden = false;
    lb.classList.add('on');
    document.body.style.overflow = 'hidden';
    closeBtn.focus();
  }

  function close() {
    lb.classList.remove('on', 'zoomed', 'panning');
    lb.hidden = true;
    document.body.style.overflow = '';
    pic.removeAttribute('src');
    if (opener && opener.focus) opener.focus();
    opener = null;
  }

  /* Delegated, so it costs nothing per image and works for any that arrive later. */
  document.addEventListener('click', function (e) {
    var img = e.target && e.target.closest ? e.target.closest('.body img') : null;
    if (!img) return;
    e.preventDefault();
    open(img.currentSrc || img.src, img.getAttribute('alt'));
  });

  closeBtn.addEventListener('click', close);

  /* Anything that is not the picture itself is the backdrop. */
  lb.addEventListener('click', function (e) {
    if (e.target === lb || e.target === stage) close();
  });

  stage.addEventListener('dblclick', function (e) {
    e.preventDefault();
    if (scale > 1) reset(); else zoomAt(e.clientX, e.clientY, 2.5);
  });

  stage.addEventListener('wheel', function (e) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.16 : 1 / 1.16);
  }, { passive: false });

  /* Pointer events rather than mouse plus touch, so one path covers dragging with
     a mouse and pinching with two fingers. */
  stage.addEventListener('pointerdown', function (e) {
    if (e.target !== pic) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 1 && scale > 1) {
      panFrom = { x: e.clientX - tx, y: e.clientY - ty };
      lb.classList.add('panning');
    } else if (pointers.size === 2) {
      var p = Array.from(pointers.values());
      pinchFrom = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      scaleFrom = scale;
      panFrom = null;
      lb.classList.remove('panning');
    }
  });

  stage.addEventListener('pointermove', function (e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.size === 2 && pinchFrom > 0) {
      var p = Array.from(pointers.values());
      var now = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      var mx = (p[0].x + p[1].x) / 2;
      var my = (p[0].y + p[1].y) / 2;
      var want = Math.min(MAX, Math.max(MIN, scaleFrom * (now / pinchFrom)));
      zoomAt(mx, my, want / scale);
      return;
    }

    if (panFrom) {
      tx = e.clientX - panFrom.x;
      ty = e.clientY - panFrom.y;
      apply();
    }
  });

  function release(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchFrom = 0;
    if (pointers.size === 0) { panFrom = null; lb.classList.remove('panning'); }
  }
  stage.addEventListener('pointerup', release);
  stage.addEventListener('pointercancel', release);

  document.addEventListener('keydown', function (e) {
    if (lb.hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1.25); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomAt(innerWidth / 2, innerHeight / 2, 1 / 1.25); }
    else if (e.key === '0') { e.preventDefault(); reset(); }
    /* Only one control in here, so Tab has nowhere else to go. */
    else if (e.key === 'Tab') { e.preventDefault(); closeBtn.focus(); }
  });
})();
</script>
</body>
</html>`;
}
