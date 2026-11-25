// Compare the live Good Threads Notion site against this backup, and optionally update the backup.
//   node tools/sync.mjs                 print what differs, change nothing
//   node tools/sync.mjs --apply         rewrite the out-of-date section pages to match Notion
//   node tools/sync.mjs --save x.json   also save the raw Notion snapshot
// Uses Notion's public page API (no login, not an official API, so it can break). Needs Node 18+.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'https://goodthread.notion.site/api/v3';
const ROOT = '8b810802-240a-4455-a343-e0a2c6bbe53a';

// ---- Notion fetch ----

const blocks = {};
const emojis = {};

async function post(endpoint, body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${HOST}/${endpoint}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (res.ok) return res.json();
    await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
  }
  throw new Error(`Notion ${endpoint} failed`);
}

function absorb(recordMap) {
  for (const [id, rec] of Object.entries(recordMap?.block || {})) {
    const v = rec.value?.value || rec.value;
    if (v) blocks[id] = v;
  }
}

async function loadPage(id) {
  let cursor = { stack: [] };
  for (let chunk = 0; ; chunk++) {
    const r = await post('loadCachedPageChunk', { page: { id }, limit: 100, cursor, chunkNumber: chunk, verticalColumns: false });
    absorb(r.recordMap);
    if (!r.cursor?.stack?.length) break;
    cursor = r.cursor;
  }
}

// The plain syncRecordValues endpoint is behind Cloudflare; the "Main" variant is not.
async function fillMissing(ids) {
  let missing = ids.filter(id => !blocks[id]);
  while (missing.length) {
    for (let i = 0; i < missing.length; i += 100) {
      const r = await post('syncRecordValuesMain', {
        requests: missing.slice(i, i + 100).map(id => ({ pointer: { table: 'block', id }, version: -1 })),
      });
      absorb(r.recordMap);
    }
    const next = missing.filter(id => !blocks[id]);
    // Stop rather than diff a half-loaded page, which would show its links as removed.
    if (next.length === missing.length) throw new Error(`Notion returned no data for ${next.length} block(s): ${next.slice(0, 3).join(', ')}`);
    missing = next;
  }
}

async function loadEmojis(ids) {
  ids = ids.filter(id => !(id in emojis));
  if (!ids.length) return;
  const r = await post('syncRecordValuesMain', {
    requests: ids.map(id => ({ pointer: { table: 'custom_emoji', id, spaceId: blocks[ROOT].space_id }, version: -1 })),
  });
  for (const id of ids) {
    const rec = r.recordMap?.custom_emoji?.[id];
    const v = rec?.value?.value || rec?.value;
    emojis[id] = { name: v?.name || 'emoji', url: v?.url || '' };
  }
}

const isExternal = u => /^https?:\/\//.test(u) && !/^https?:\/\/(www\.)?notion\.so\//.test(u);

// Rich text -> [{ text, href?, bold?, italic?, strike?, emoji? }], with mentions resolved.
async function segments(b) {
  const raw = b.properties?.title || [];
  const marksOf = type => raw.flatMap(([, marks]) => (marks || []).filter(m => m[0] === type).map(m => m[1]));
  await fillMissing(marksOf('p'));
  await loadEmojis(marksOf('ce'));
  return raw.map(([text, marks = []]) => {
    const has = t => marks.find(m => m[0] === t);
    const seg = { text };
    if (has('p')) seg.text = (blocks[has('p')[1]]?.properties?.title || []).map(s => s[0]).join('').trim();
    if (has('ce')) { seg.emoji = emojis[has('ce')[1]]; seg.text = `:${seg.emoji.name}:`; }
    if (has('a') && isExternal(has('a')[1])) seg.href = has('a')[1];
    if (has('b')) seg.bold = true;
    if (has('i')) seg.italic = true;
    if (has('s')) seg.strike = true;
    return seg;
  });
}

const plainText = segs => segs.map(s => s.text).join('');

// A section page as a tree of items, descending into toggles/columns but not sub-pages.
async function readTree(id) {
  const b = blocks[id];
  await fillMissing(b?.content || []);
  const items = [];
  for (const cid of b?.content || []) {
    const c = blocks[cid];
    if (!c || c.alive === false || c.type === 'page') continue;
    const segs = await segments(c);
    const source = c.properties?.source?.[0]?.[0];
    const links = [...new Set([...segs.filter(s => s.href).map(s => s.href), ...(isExternal(source || '') ? [source] : [])])];
    items.push({ type: c.type, segs, source, links, children: c.content?.length ? await readTree(cid) : [] });
  }
  return items;
}

const flat = items => items.flatMap(i => [i, ...flat(i.children)]);
const hasLink = i => i.links.length || i.children.some(hasLink);

async function snapshot() {
  await loadPage(ROOT);
  if (!blocks[ROOT]?.content) throw new Error('Could not load the Good Threads root page');
  await fillMissing(blocks[ROOT].content);
  const groups = [];
  for (const cid of blocks[ROOT].content) {
    const h = blocks[cid];
    if (h?.type !== 'sub_header' || !h.content?.length) continue;
    await fillMissing(h.content);
    const group = { title: plainText(await segments(h)).trim(), sections: [] };
    for (const sid of h.content) {
      const s = blocks[sid];
      if (!s || s.alive === false) continue;
      const title = plainText(await segments(s)).trim();
      if (s.type === 'page') {
        await loadPage(sid);
        const items = await readTree(sid);
        if (!flat(items).some(i => i.links.length)) throw new Error(`Section "${title}" came back with no links; refusing to diff it`);
        group.sections.push({ title, icon: s.format?.page_icon || null, items });
      } else {
        const segs = await segments(s);
        if (segs.some(x => x.href)) group.sections.push({ title, links: segs.filter(x => x.href).map(x => x.href) });
      }
    }
    groups.push(group);
  }
  if (!groups.some(g => g.sections.some(s => s.items))) throw new Error('No sections found; the Notion page layout may have changed');
  return { fetchedAt: new Date().toISOString(), groups };
}

// ---- Rendering Notion items as backup HTML ----

const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = s => esc(s).replace(/"/g, '&quot;');

function renderSegs(segs) {
  const html = segs.map(s => {
    if (s.emoji) return `<img src="${attr(s.emoji.url)}" alt="${attr(s.text)}" style="width:1em;height:1em;vertical-align:middle">`;
    let h = esc(s.text.replace(/ㅤ/g, ' '));
    if (s.bold) h = `<b>${h}</b>`;
    if (s.italic) h = `<i>${h}</i>`;
    if (s.strike) h = `<s>${h}</s>`;
    if (s.href) h = `<a href="${attr(s.href)}">${h}</a>`;
    return h;
  }).join('');
  return html.replace(/\s+/g, ' ').trim();
}

function renderItems(items) {
  const out = [];
  for (const i of items) {
    const inner = renderSegs(i.segs) || (i.source && isExternal(i.source) ? `<a href="${attr(i.source)}">${esc(i.source)}</a>` : '');
    if (i.type === 'toggle') {
      out.push(`<details><summary class="collapsiblea">${inner}</summary>`, ...renderItems(i.children), '</details>');
      continue;
    }
    if (i.type === 'divider') out.push('<hr>');
    else if (inner) out.push(/header$/.test(i.type) ? `<h3>${inner}</h3>` : `<p>${inner}</p>`);
    out.push(...renderItems(i.children));
  }
  return out;
}

// ---- Backup side ----

const norm = u => u.trim().replace(/^http:/, 'https:').replace(/\/+$/, '').toLowerCase();
const key = s => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const decode = s => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
const squash = s => decode(s).replace(/[\sㅤ]+/g, ' ').trim();
const textOf = html => squash(html.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, '$1').replace(/<[^>]+>/g, ''));
const P = /<p\b[^>]*>([\s\S]*?)<\/p>/g;

function localLines(html) {
  const body = html.split(/<div class="t-container">/)[1] || html;
  return [...body.matchAll(P)]
    .map(m => {
      const anchors = [...m[1].matchAll(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        .map(a => ({ href: decode(a[1]), label: textOf(a[2]) }))
        .filter(a => isExternal(a.href));
      return { anchors, links: anchors.map(a => a.href), text: textOf(m[1]) };
    })
    .filter(l => l.links.length);
}

// Swap the run of link paragraphs in an existing page for freshly rendered Notion lines.
// Everything before the first link and after the last one (header, notes, scripts) is kept.
function patchPage(html, items) {
  const bodyStart = html.indexOf('<div class="t-container">') + 1;
  const linkPs = [...html.matchAll(P)].filter(m => m.index >= bodyStart && /href="https?:\/\//.test(m[1]));
  const first = linkPs[0], last = linkPs.at(-1);
  let prefix = html.slice(0, first.index);
  let suffix = html.slice(last.index + last[0].length);
  // Notion exports leave a stray </p> before the list and empty <p></p> pairs after each line.
  const opens = (prefix.slice(bodyStart).match(/<p\b/g) || []).length;
  const closes = (prefix.slice(bodyStart).match(/<\/p>/g) || []).length;
  if (closes > opens) prefix = prefix.replace(/<\/p>\s*$/, '');
  suffix = suffix.replace(/^(\s*<p\b[^>]*>\s*<\/p>)+/, '').replace(/^\s*<p\b[^>]*>\s*(?=<\/(div|body)>)/, '');
  if (!/<\/div>/.test(suffix)) suffix = `</div>\n${suffix.trimStart()}`;
  const start = items.findIndex(hasLink);
  const lines = renderItems(items.slice(start));
  return `${prefix.trimEnd()}\n${lines.join('\n')}\n${suffix.trimStart()}`;
}

function newPage(sec) {
  const heading = `${sec.icon && !sec.icon.startsWith('http') ? sec.icon + ' ' : ''}${sec.title}`;
  const start = sec.items.findIndex(hasLink);
  const intro = renderItems(sec.items.slice(0, start));
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <link rel= "stylesheet" type= "text/css" href= "/css/master.css">
    <title>${esc(heading)}</title>
</head>
<body>
<div class="t-container">
<a href="/" class="back-btn">← Back</a>
<h2>${esc(heading)}</h2>
${intro.length ? intro.join('\n') + '\n' : ''}<br>
${renderItems(sec.items.slice(start)).join('\n')}
</div>
</body>
</html>
`;
}

// ---- Diff ----

function diffSection(remote, local) {
  const out = [];
  const localByUrl = new Map();
  for (const l of local) for (const u of l.links) localByUrl.set(norm(u), [...(localByUrl.get(norm(u)) || []), l]);
  const remoteUrls = new Set(remote.flatMap(l => l.links.map(norm)));

  for (const l of remote) {
    const text = squash(plainText(l.segs));
    // Several lines can share a URL, so prefer the one whose text also matches.
    const candidates = l.links.flatMap(u => localByUrl.get(norm(u)) || []);
    const match = candidates.find(c => key(c.text) === key(text)) || candidates[0];
    if (!match) { out.push(`  + ${text}`); continue; }
    const missing = l.links.filter(u => !localByUrl.has(norm(u)));
    if (missing.length) out.push(`  + extra link ${missing.join(' ')} on: ${text}`);
    const sameLinks = match.links.length === l.links.length && match.links.every(u => l.links.some(v => norm(v) === norm(u)));
    if (sameLinks && key(match.text) !== key(text)) out.push(`  ~ ${match.text}\n    → ${text}`);
  }
  for (const l of local)
    for (const u of l.links) if (!remoteUrls.has(norm(u))) out.push(`  - ${u}   (was: ${l.text})`);
  return out;
}

// Links whose visible URL names a different site than the one they go to (also checked on Notion's side).
const host = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return u; } };
function mislinks(local) {
  return local.flatMap(l => l.anchors)
    .filter(a => /^https?:\/\//.test(a.label) && host(a.label) !== host(a.href))
    .map(a => `  ! "${a.label}" actually links to ${a.href}`);
}

// ---- Main ----

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const snap = await snapshot();
if (args.includes('--save')) writeFileSync(args[args.indexOf('--save') + 1], JSON.stringify(snap, null, 2));

let index = readFileSync(join(REPO, 'index.html'), 'utf8');
const files = {};
for (const m of index.matchAll(/<a href="\/?(Category\d\/[^"]+\.htm)">([^<]+)<\/a>/g)) files[key(m[2])] = m[1];

let total = 0;
const written = [];
const report = (title, lines) => {
  if (!lines.length) return;
  console.log(`\n## ${title}`);
  lines.forEach(l => console.log(l));
};

for (const group of snap.groups) {
  if (/mega/i.test(group.title)) {
    // Mega-threads live inline in index.html and are edited by hand.
    const remote = new Set(group.sections.flatMap(s => s.links || []).map(norm));
    const block = index.slice(index.search(/mega-?threads/i));
    const local = new Set([...block.matchAll(/href="([^"]+)"/g)].map(m => decode(m[1])).filter(isExternal).map(norm));
    const out = [
      ...[...remote].filter(u => !local.has(u)).map(u => `  + ${u}`),
      ...[...local].filter(u => !remote.has(u)).map(u => `  - ${u}`),
    ];
    total += out.length;
    report(`Good Mega-threads  →  index.html${apply && out.length ? '  (edit by hand)' : ''}`, out);
    continue;
  }
  group.sections.forEach((sec, n) => {
    if (!sec.items) return;
    const lines = flat(sec.items).filter(i => i.links.length);
    const file = files[key(sec.title)];

    if (!file || !existsSync(join(REPO, file))) {
      // New section: create its page and list it on index.html next to its Notion neighbours.
      const siblings = group.sections.map(s => files[key(s.title)]).filter(Boolean);
      const dir = siblings[0]?.split('/')[0] || 'Category2';
      const path = `${dir}/${sec.title.replace(/[^A-Za-z0-9]/g, '')}.htm`;
      total += lines.length;
      report(`${sec.icon || ''} ${sec.title}  [NEW SECTION under "${group.title}"${apply ? ` → created ${path}` : ''}]`,
        lines.map(l => `  + ${squash(plainText(l.segs))}`));
      if (!apply) return;
      writeFileSync(join(REPO, path), newPage(sec));
      const icon = !sec.icon ? '' : sec.icon.startsWith('http') ? `<img src="${attr(sec.icon)}" style="width:1em;height:1em;vertical-align:middle"> ` : `${sec.icon} `;
      const entry = `<p>${icon}<a href="/${path}">${esc(sec.title)}</a></p>`;
      const prev = group.sections.slice(0, n).reverse().map(s => files[key(s.title)]).find(Boolean);
      const next = group.sections.slice(n + 1).map(s => files[key(s.title)]).find(Boolean);
      const anchor = new RegExp(`^([ \\t]*)<p>.*href="/${(prev || next).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}".*$`, 'm');
      index = index.replace(anchor, (line, indent) => prev ? `${line}\n${indent}${entry}` : `${indent}${entry}\n${line}`);
      files[key(sec.title)] = path;
      written.push(path, 'index.html');
      return;
    }

    const html = readFileSync(join(REPO, file), 'utf8');
    const out = diffSection(lines, localLines(html));
    total += out.length;
    const notionMislinks = new Set(mislinks(lines.map(l => ({ anchors: l.segs.filter(s => s.href).map(s => ({ href: s.href, label: s.text.trim() })) }))));
    const warnings = mislinks(localLines(html)).map(w => notionMislinks.has(w) ? `${w}  (same on Notion)` : w);
    report(`${sec.title}  →  ${file}${apply && out.length ? '  (updated)' : ''}`, [...out, ...warnings]);
    if (apply && out.length) {
      writeFileSync(join(REPO, file), patchPage(html, sec.items));
      written.push(file);
    }
  });
}

if (apply && written.length) {
  const today = new Date().toISOString().slice(0, 10);
  index = index.replace(/(id="sync-date" data-date=")[^"]*"/, `$1${today}"`);
  writeFileSync(join(REPO, 'index.html'), index);
  console.log(`\nUpdated ${[...new Set([...written, 'index.html'])].length} file(s); sync date set to ${today}. Re-run without --apply to confirm.`);
} else {
  console.log(total ? `\n${total} difference(s) vs Notion (${snap.fetchedAt}).${apply ? '' : ' Run with --apply to update the backup.'}` : '\nBackup is in sync with Notion.');
}
