import { randomUUID } from 'node:crypto'
import { strToU8, zipSync } from 'fflate'
import { all, get } from './db.ts'

function load(id: number) {
  const book = get('select * from books where id = ?', id)
  if (!book) return
  const bible = book.bible ? JSON.parse(book.bible) : {}
  const settings = JSON.parse(book.settings)
  const chapters = all<{ idx: number; title: string; text: string }>(
    'select idx, title, text from chapters where book_id = ? and text is not null order by idx', id)
  return { title: book.title as string, logline: (bible.logline ?? '') as string, language: settings.language as string, chapters }
}

export function toMarkdown(id: number) {
  const b = load(id)
  if (!b) return
  return [`# ${b.title}`, b.logline && `*${b.logline}*`, ...b.chapters.map(c => `## Chapter ${c.idx}: ${c.title}\n\n${c.text}`)].filter(Boolean).join('\n\n') + '\n'
}

export function toText(id: number) {
  const b = load(id)
  if (!b) return
  return [b.title, ...b.chapters.map(c => `Chapter ${c.idx}: ${c.title}\n\n${c.text.replace(/\*([^*\n]+)\*/g, '$1')}`)].join('\n\n\n') + '\n'
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const paras = (text: string) =>
  text.split(/\n+/).filter(p => p.trim()).map(p => {
    const html = esc(p.trim()).replace(/\*([^*\n]+)\*/g, '<em>$1</em>')
    return /^\[.*\]$/.test(p.trim()) ? `<p class="sys">${html}</p>` : `<p>${html}</p>`
  }).join('\n')

const page = (title: string, lang: string, body: string) => `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}" lang="${lang}">
<head><meta charset="utf-8"/><title>${esc(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>${body}</body></html>`

const CSS = `body{font-family:serif;line-height:1.6;margin:0 5%}h1{text-align:center;margin:2em 0 1.5em;font-size:1.4em}
p{margin:0;text-indent:1.2em}h1+p,p.sys,p.sys+p{text-indent:0}p.sys{font-family:monospace;font-size:.9em;margin:.6em 0}
.title{text-align:center;margin-top:30%}.title h1{font-size:2em}.title p{text-indent:0;font-style:italic}`

const LANGS = 'en ja ko zh es fr de id pt ru vi th it tr ar hi pl nl ms tl'.split(' ')
const langCode = (name: string) => {
  const names = new Intl.DisplayNames(['en'], { type: 'language' })
  return LANGS.find(c => names.of(c)?.toLowerCase() === name?.trim().toLowerCase()) ?? 'en'
}

export function toEpub(id: number) {
  const b = load(id)
  if (!b) return
  const lang = langCode(b.language)
  const files = b.chapters.map(c => ({ ...c, file: `ch${String(c.idx).padStart(4, '0')}.xhtml` }))
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="${lang}">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:uuid:${randomUUID()}</dc:identifier>
<dc:title>${esc(b.title)}</dc:title>
<dc:language>${lang}</dc:language>
<meta property="dcterms:modified">${new Date().toISOString().slice(0, 19)}Z</meta>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="css" href="style.css" media-type="text/css"/>
<item id="title" href="title.xhtml" media-type="application/xhtml+xml"/>
${files.map(f => `<item id="c${f.idx}" href="${f.file}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine><itemref idref="title"/>${files.map(f => `<itemref idref="c${f.idx}"/>`).join('')}</spine>
</package>`
  const nav = page('Contents', lang, `<nav epub:type="toc"><h1>Contents</h1><ol>${files.map(f => `<li><a href="${f.file}">${f.idx}. ${esc(f.title)}</a></li>`).join('')}</ol></nav>`)
  return zipSync({
    mimetype: [strToU8('application/epub+zip'), { level: 0 }], // must be first and stored
    'META-INF/container.xml': strToU8(`<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`),
    'OEBPS/content.opf': strToU8(opf),
    'OEBPS/nav.xhtml': strToU8(nav),
    'OEBPS/style.css': strToU8(CSS),
    'OEBPS/title.xhtml': strToU8(page(b.title, lang, `<div class="title"><h1>${esc(b.title)}</h1>${b.logline ? `<p>${esc(b.logline)}</p>` : ''}</div>`)),
    ...Object.fromEntries(files.map(f => [`OEBPS/${f.file}`, strToU8(page(f.title, lang, `<h1>Chapter ${f.idx}<br/>${esc(f.title)}</h1>\n${paras(f.text)}`))])),
  })
}
