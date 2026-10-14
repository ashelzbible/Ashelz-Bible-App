/* Export: turns a devotion, prayer, journal entry, note or post into a PDF or a Word (.docx) file on the phone. No library, no internet.
   A document is { title, blocks }. Block kinds: h1 h2 h3 p li q hr small img.  Text blocks carry runs [{ t, b, i, u }].  Image blocks carry { blob, w, h } (JPEG). */
window.Export = (function(){
  var WR = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584, 750, 556, 0, 222, 556, 333, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 222, 222, 333, 333, 350, 556, 1000, 333, 1000, 500, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 260, 556, 333, 737, 370, 556, 584, 0, 737, 552, 400, 549, 333, 333, 333, 576, 537, 333, 333, 333, 365, 556, 834, 834, 834, 611, 667, 667, 667, 667, 667, 667, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 500, 556, 556, 556, 556, 278, 278, 278, 278, 556, 556, 556, 556, 556, 556, 556, 549, 611, 556, 556, 556, 556, 500, 556, 500], WB = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584, 750, 556, 0, 278, 556, 500, 1000, 556, 556, 333, 1000, 667, 333, 1000, 0, 611, 0, 0, 278, 278, 500, 500, 350, 556, 1000, 333, 1000, 556, 333, 944, 0, 500, 667, 278, 333, 556, 556, 556, 556, 280, 556, 333, 737, 370, 556, 584, 0, 737, 552, 400, 549, 333, 333, 333, 576, 556, 333, 333, 333, 365, 556, 834, 834, 834, 611, 722, 722, 722, 722, 722, 722, 1000, 722, 667, 667, 667, 667, 278, 278, 278, 278, 722, 722, 778, 778, 778, 778, 778, 584, 778, 722, 722, 722, 722, 667, 667, 611, 556, 556, 556, 556, 556, 556, 889, 556, 556, 556, 556, 556, 278, 278, 278, 278, 611, 611, 611, 611, 611, 611, 611, 549, 611, 611, 611, 611, 611, 556, 611, 556];
  var FOOT = 'Ashelz Bible App, https://ashelzbible.github.io/Ashelz-Bible-App/';
  /* ---------- building documents ---------- */
  function run(t, o){ o = o || {}; return { t: String(t), b: !!o.b, i: !!o.i, u: !!o.u }; }
  function fromText(title, text, extra){ var blocks = []; if(title) blocks.push({ k: 'h1', runs: [run(title, { b: 1 })] });
    String(text || '').replace(/\r/g, '').split('\n').forEach(function(line){ if(!line.trim()){ blocks.push({ k: 'sp' }); return; } var m = /^\s*[-•*]\s+(.*)$/.exec(line); if(m) blocks.push({ k: 'li', runs: [run(m[1])] }); else blocks.push({ k: 'p', runs: [run(line)] }); });
    (extra || []).forEach(function(b){ blocks.push(b); }); blocks.push({ k: 'small', runs: [run(FOOT)] }); return { title: title || '', blocks: blocks }; }
  function fromHtml(title, html){ var d = new DOMParser().parseFromString('<body>' + String(html || '') + '</body>', 'text/html'), blocks = [{ k: 'h1', runs: [run(title, { b: 1 })] }], cur = null, ol = 0;
    function flush(){ if(cur && cur.runs.some(function(r){ return r.t.trim(); })) blocks.push(cur); cur = null; }
    function start(k){ flush(); cur = { k: k, runs: [] }; }
    function walk(n, st){ if(n.nodeType === 3){ var t = n.textContent.replace(/\s+/g, ' '); if(!t || (!t.trim() && !cur)) return; if(!cur) start('p'); cur.runs.push({ t: t, b: !!st.b, i: !!st.i, u: !!st.u }); return; }
      if(n.nodeType !== 1) return; var tag = n.tagName.toLowerCase(), s = { b: st.b, i: st.i, u: st.u };
      if(tag === 'b' || tag === 'strong') s.b = 1; if(tag === 'i' || tag === 'em') s.i = 1; if(tag === 'u') s.u = 1;
      if(tag === 'br'){ if(cur) cur.runs.push({ t: '\n', b: 0, i: 0, u: 0 }); return; }
      if(tag === 'hr'){ flush(); blocks.push({ k: 'hr' }); return; }
      if(tag === 'img' || tag === 'script' || tag === 'style') return;
      if(/^h[1-3]$/.test(tag)){ start(tag === 'h1' ? 'h2' : tag === 'h2' ? 'h2' : 'h3'); s.b = 1; }
      else if(tag === 'blockquote'){ start('q'); s.i = 1; }
      else if(tag === 'ol'){ ol = 0; flush(); }
      else if(tag === 'ul'){ ol = -1; flush(); }
      else if(tag === 'li'){ start('li'); if(ol >= 0){ ol++; cur.num = ol; } }
      else if(tag === 'tr'){ start('p'); }
      else if(tag === 'td' || tag === 'th'){ if(cur && cur.runs.length) cur.runs.push({ t: '    ', b: 0, i: 0, u: 0 }); }
      else if(tag === 'p' || tag === 'div'){ start('p'); }
      Array.prototype.forEach.call(n.childNodes, function(c){ walk(c, s); });
      if(/^(h[1-3]|blockquote|li|tr|p|div)$/.test(tag)) flush(); }
    Array.prototype.forEach.call(d.body.childNodes, function(c){ walk(c, {}); }); flush(); blocks.push({ k: 'small', runs: [run(FOOT)] }); return { title: title, blocks: blocks }; }
  function jpegInfo(blob){ return new Promise(function(res, rej){ var u = URL.createObjectURL(blob), im = new Image(); im.onload = function(){ var cv = document.createElement('canvas'); cv.width = im.width; cv.height = im.height; var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(im, 0, 0); URL.revokeObjectURL(u); cv.toBlob(function(b){ b.arrayBuffer().then(function(ab){ res({ bytes: new Uint8Array(ab), w: cv.width, h: cv.height }); }); }, 'image/jpeg', 0.9); }; im.onerror = function(){ URL.revokeObjectURL(u); rej(new Error('picture')); }; im.src = u; }); }
  /* load every image block (blob or address) into JPEG bytes first */
  function prepare(doc){ var jobs = doc.blocks.map(function(b){ if(b.k !== 'img' || b.jpeg) return null; var get = b.blob ? Promise.resolve(b.blob) : fetch(b.src).then(function(r){ if(!r.ok) throw 0; return r.blob(); }); return get.then(jpegInfo).then(function(j){ b.jpeg = j; }, function(){ b.k = 'sp'; }); }); return Promise.all(jobs).then(function(){ return doc; }); }

  /* ---------- zip (stored) ---------- */
  var CT; function crc32(d){ if(!CT){ CT = []; for(var n = 0; n < 256; n++){ var c = n; for(var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; CT[n] = c >>> 0; } } var c2 = 0xFFFFFFFF; for(var i = 0; i < d.length; i++) c2 = CT[(c2 ^ d[i]) & 255] ^ (c2 >>> 8); return (c2 ^ 0xFFFFFFFF) >>> 0; }
  function zip(files){ var enc = new TextEncoder(), parts = [], cen = [], off = 0; function u16(v){ return [v & 255, (v >> 8) & 255]; } function u32(v){ return [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255]; }
    files.forEach(function(f){ var nm = enc.encode(f.name), data = typeof f.data === 'string' ? enc.encode(f.data) : f.data, crc = crc32(data), loc = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0));
      parts.push(new Uint8Array(loc), nm, data); cen.push(new Uint8Array([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(data.length), u32(data.length), u16(nm.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(off))), nm); off += loc.length + nm.length + data.length; });
    var cs = 0; cen.forEach(function(c){ cs += c.length; }); var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cs), u32(off), u16(0))); return new Blob(parts.concat(cen, [end]), { type: 'application/zip' }); }

  /* ---------- Word (.docx) ---------- */
  function esc(s){ return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
  var SZ = { h1: 40, h2: 32, h3: 26, p: 23, li: 23, q: 23, small: 17 };
  function rpr(r, k){ return '<w:rPr>' + (r.b || /^h/.test(k) ? '<w:b/>' : '') + (r.i || k === 'q' ? '<w:i/>' : '') + (r.u ? '<w:u w:val="single"/>' : '') + (k === 'small' ? '<w:color w:val="777777"/>' : '') + '<w:sz w:val="' + (SZ[k] || 23) + '"/></w:rPr>'; }
  function runXml(r, k){ var parts = r.t.split('\n'), x = ''; parts.forEach(function(p, i){ if(i) x += '<w:r><w:br/></w:r>'; if(p) x += '<w:r>' + rpr(r, k) + '<w:t xml:space="preserve">' + esc(p) + '</w:t></w:r>'; }); return x; }
  function rtl(t){ return /[֐-ࣿ]/.test(t); }
  function docx(doc){ var body = '', media = [], rels = '', imgN = 0;
    doc.blocks.forEach(function(b){ var k = b.k;
      if(k === 'sp'){ body += '<w:p><w:pPr><w:spacing w:after="0"/></w:pPr></w:p>'; return; }
      if(k === 'hr'){ body += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="999999"/></w:pBdr></w:pPr></w:p>'; return; }
      if(k === 'img' && b.jpeg){ imgN++; var id = 'rIdImg' + imgN, maxW = 5400000, w = b.jpeg.w, h = b.jpeg.h, cx = Math.min(maxW, w * 9525), cy = Math.round(cx * h / w); if(cy > 6600000){ cy = 6600000; cx = Math.round(cy * w / h); }
        media.push({ name: 'word/media/image' + imgN + '.jpg', data: b.jpeg.bytes }); rels += '<Relationship Id="' + id + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image' + imgN + '.jpg"/>';
        body += '<w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="' + cx + '" cy="' + cy + '"/><wp:docPr id="' + imgN + '" name="Picture ' + imgN + '"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="' + imgN + '" name="image' + imgN + '.jpg"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="' + id + '"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>'; return; }
      if(!b.runs) return; var txt = b.runs.map(function(r){ return r.t; }).join(''), ppr = '<w:pPr>' + (rtl(txt) ? '<w:bidi/>' : '') + '<w:spacing w:after="' + (k === 'h1' ? 200 : k === 'li' ? 60 : 120) + '"' + (k === 'p' || k === 'q' || k === 'li' ? ' w:line="300" w:lineRule="auto"' : '') + '/>' + (k === 'li' ? '<w:ind w:left="540" w:hanging="270"/>' : k === 'q' ? '<w:ind w:left="540"/>' : '') + '</w:pPr>';
      var pre = k === 'li' ? '<w:r><w:t xml:space="preserve">' + (b.num ? b.num + '. ' : '• ') + '</w:t></w:r>' : '';
      body += '<w:p>' + ppr + pre + b.runs.map(function(r){ return runXml(r, k); }).join('') + '</w:p>'; });
    var ns = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"';
    var files = [{ name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="jpg" ContentType="image/jpeg"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>' },
      { name: '_rels/.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>' },
      { name: 'word/_rels/document.xml.rels', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + rels + '</Relationships>' },
      { name: 'word/document.xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ' + ns + '><w:body>' + body + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>' }].concat(media);
    var bl = zip(files); return new Blob([bl], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }); }

  /* ---------- PDF ---------- */
  var WIN = { 0x2018: 145, 0x2019: 146, 0x201C: 147, 0x201D: 148, 0x2022: 149, 0x2013: 150, 0x2014: 151, 0x2026: 133, 0x20AC: 128, 0x2122: 153, 0x2039: 139, 0x203A: 155, 0x0152: 140, 0x0153: 156, 0x0160: 138, 0x0161: 154, 0x017D: 142, 0x017E: 158, 0x0178: 159, 0x2020: 134, 0x2021: 135, 0x02C6: 136, 0x2030: 137, 0x0192: 131, 0x201A: 130, 0x201E: 132, 0x02DC: 152 };
  function toWin(ch){ var c = ch.charCodeAt(0); if(c === 160) return 32; if(c < 256 && (c >= 32 && c < 127 || c >= 161)) return c; if(WIN[c]) return WIN[c]; if(c === 9) return 32; return -1; }
  function needsRaster(doc){ return doc.blocks.some(function(b){ return b.runs && b.runs.some(function(r){ return r.t.split('').some(function(ch){ return ch !== '\n' && toWin(ch) < 0; }); }); }); }
  function wOf(code, bold){ var t = bold ? WB : WR; return (t[code - 32] || 500); }
  function textW(s, size, bold){ var w = 0; for(var i = 0; i < s.length; i++){ var c = toWin(s[i]); w += wOf(c < 0 ? 63 : c, bold); } return w * size / 1000; }
  function pdfEsc(s){ var o = ''; for(var i = 0; i < s.length; i++){ var c = toWin(s[i]); if(c < 0) c = 63; var ch = String.fromCharCode(c); o += (ch === '(' || ch === ')' || ch === '\\') ? '\\' + ch : ch; } return o; }
  var PW = 595.28, PH = 841.89, MX = 56, MT = 60, MB = 56;
  function layout(doc){ /* returns pages: [{ ops: [] }] using the standard fonts */
    var pages = [], page = null, y = 0, imgIdx = 0;
    function np(){ page = { ops: [], imgs: [] }; pages.push(page); y = PH - MT; }
    np();
    doc.blocks.forEach(function(b){ var k = b.k;
      if(k === 'sp'){ y -= 8; return; }
      if(k === 'hr'){ if(y < MB + 10) np(); page.ops.push('0.6 G 0.8 w ' + MX + ' ' + (y - 4).toFixed(1) + ' m ' + (PW - MX) + ' ' + (y - 4).toFixed(1) + ' l S'); y -= 12; return; }
      if(k === 'img' && b.jpeg){ var maxW = PW - 2 * MX, w = Math.min(maxW, b.jpeg.w * 0.75), h = w * b.jpeg.h / b.jpeg.w; if(h > 560){ h = 560; w = h * b.jpeg.w / b.jpeg.h; } if(y - h < MB) np(); var x = (PW - w) / 2; page.imgs.push(b.jpeg); var n = page.imgs.length; page.ops.push('q ' + w.toFixed(1) + ' 0 0 ' + h.toFixed(1) + ' ' + x.toFixed(1) + ' ' + (y - h).toFixed(1) + ' cm /Im' + n + ' Do Q'); y -= h + 10; return; }
      if(!b.runs) return;
      var size = k === 'h1' ? 20 : k === 'h2' ? 15 : k === 'h3' ? 12.5 : k === 'small' ? 8.5 : 11, lead = size * 1.38, indent = k === 'li' ? 22 : k === 'q' ? 22 : 0, bullet = k === 'li' ? (b.num ? b.num + '.' : '•') : '', left = MX + indent, maxW = PW - MX - left;
      /* words with style */
      var words = []; b.runs.forEach(function(r){ var bold = r.b || /^h/.test(k), ital = r.i || k === 'q'; r.t.split(/(\n| )/).forEach(function(tok){ if(tok === '') return; words.push({ t: tok, b: bold, i: ital, u: r.u }); }); });
      var lines = [], line = [], lw = 0;
      words.forEach(function(w){ if(w.t === '\n'){ lines.push(line); line = []; lw = 0; return; } var wd = textW(w.t, size, w.b); if(w.t === ' '){ if(!line.length) return; line.push(w); lw += wd; return; } if(lw + wd > maxW && line.length){ while(line.length && line[line.length - 1].t === ' ') line.pop(); lines.push(line); line = []; lw = 0; } line.push(w); lw += wd; });
      if(line.length) lines.push(line);
      if(!lines.length) return;
      var need = lead * Math.min(lines.length, 2); if(y - need < MB) np();
      lines.forEach(function(ln, li){ if(y - lead < MB) np(); y -= lead; var x = left, cmds = [];
        if(li === 0 && bullet) page.ops.push('BT /F1 ' + size + ' Tf ' + (MX + 4) + ' ' + y.toFixed(1) + ' Td (' + pdfEsc(bullet) + ') Tj ET');
        ln.forEach(function(w){ var f = w.b && w.i ? 'F4' : w.b ? 'F2' : w.i ? 'F3' : 'F1', wd = textW(w.t, size, w.b); page.ops.push('BT /' + f + ' ' + size + ' Tf ' + x.toFixed(1) + ' ' + y.toFixed(1) + ' Td (' + pdfEsc(w.t) + ') Tj ET'); if(w.u && w.t !== ' ') page.ops.push('0.4 w ' + x.toFixed(1) + ' ' + (y - 1.5).toFixed(1) + ' m ' + (x + wd).toFixed(1) + ' ' + (y - 1.5).toFixed(1) + ' l S'); x += wd; }); });
      y -= k === 'h1' ? 10 : k === 'li' ? 2 : 6; });
    return pages; }
  function assemble(pages, fonts){ /* pages: [{ ops, imgs }] */
    var objs = [], enc = function(s){ var a = new Uint8Array(s.length); for(var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) & 255; return a; };
    function add(content){ objs.push(content); return objs.length; }
    var cat = add(null), pagesObj = add(null), fontIds = {};
    if(fonts){ [['F1', 'Helvetica'], ['F2', 'Helvetica-Bold'], ['F3', 'Helvetica-Oblique'], ['F4', 'Helvetica-BoldOblique']].forEach(function(f){ fontIds[f[0]] = add('<< /Type /Font /Subtype /Type1 /BaseFont /' + f[1] + ' /Encoding /WinAnsiEncoding >>'); }); }
    var kids = [];
    pages.forEach(function(pg){ var imRes = '';
      pg.imgs.forEach(function(im, i){ var id = add({ dict: '<< /Type /XObject /Subtype /Image /Width ' + im.w + ' /Height ' + im.h + ' /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ' + im.bytes.length + ' >>', data: im.bytes }); imRes += '/Im' + (i + 1) + ' ' + id + ' 0 R '; });
      var stream = pg.ops.join('\n'), cid = add({ dict: '<< /Length ' + stream.length + ' >>', data: enc(stream) });
      var fr = fonts ? '/Font << ' + Object.keys(fontIds).map(function(k){ return '/' + k + ' ' + fontIds[k] + ' 0 R'; }).join(' ') + ' >>' : '';
      kids.push(add('<< /Type /Page /Parent ' + pagesObj + ' 0 R /MediaBox [0 0 ' + PW.toFixed(2) + ' ' + PH.toFixed(2) + '] /Resources << ' + fr + ' /XObject << ' + imRes + '>> >> /Contents ' + cid + ' 0 R >>')); });
    objs[cat - 1] = '<< /Type /Catalog /Pages ' + pagesObj + ' 0 R >>'; objs[pagesObj - 1] = '<< /Type /Pages /Kids [' + kids.map(function(k){ return k + ' 0 R'; }).join(' ') + '] /Count ' + kids.length + ' >>';
    var chunks = [enc('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')], pos = chunks[0].length, offs = [];
    objs.forEach(function(o, i){ offs.push(pos); var head, data; if(typeof o === 'string'){ head = enc((i + 1) + ' 0 obj\n' + o + '\nendobj\n'); chunks.push(head); pos += head.length; } else { head = enc((i + 1) + ' 0 obj\n' + o.dict + '\nstream\n'); var tail = enc('\nendstream\nendobj\n'); chunks.push(head, o.data, tail); pos += head.length + o.data.length + tail.length; } });
    var xr = 'xref\n0 ' + (objs.length + 1) + '\n0000000000 65535 f \n' + offs.map(function(o){ return ('0000000000' + o).slice(-10) + ' 00000 n \n'; }).join('') + 'trailer\n<< /Size ' + (objs.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + pos + '\n%%EOF'; chunks.push(enc(xr)); return new Blob(chunks, { type: 'application/pdf' }); }
  /* for text with letters the standard fonts lack (Arabic, Hebrew, Chinese, Tamil and so on) the pages are drawn as pictures instead */
  function rasterPdf(doc){ var S = 2, W = Math.round(PW * S), H = Math.round(PH * S), pages = [], cv, cx, y;
    function np(){ cv = document.createElement('canvas'); cv.width = W; cv.height = H; cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, W, H); cx.fillStyle = '#111'; y = MT * S; pages.push(cv); }
    np(); var FAM = 'system-ui,"Noto Sans","Segoe UI",Arial,sans-serif';
    doc.blocks.forEach(function(b){ var k = b.k; if(k === 'sp'){ y += 8 * S; return; } if(k === 'hr'){ cx.fillStyle = '#999'; cx.fillRect(MX * S, y, (PW - 2 * MX) * S, S); y += 12 * S; cx.fillStyle = '#111'; return; }
      if(k === 'img' && b.jpeg){ var im = b.jpeg, maxW = (PW - 2 * MX) * S, w = Math.min(maxW, im.w * 0.75 * S), h = w * im.h / im.w; if(h > 560 * S){ h = 560 * S; w = h * im.w / im.h; } if(y + h > H - MB * S) np(); b.__img = b.__img || null; var el = b.__el; /* drawn later */ b.__pos = { cv: cv, x: (W - w) / 2, y: y, w: w, h: h }; y += h + 10 * S; return; }
      if(!b.runs) return; var size = (k === 'h1' ? 20 : k === 'h2' ? 15 : k === 'h3' ? 12.5 : k === 'small' ? 8.5 : 11) * S, lead = size * 1.38, indent = (k === 'li' || k === 'q' ? 22 : 0) * S, left = MX * S + indent, maxW = (PW - MX) * S - left, txt = b.runs.map(function(r){ return r.t; }).join(''), isR = /[֐-ࣿ]/.test(txt);
      var bold = /^h/.test(k) || b.runs.every(function(r){ return r.b; }), ital = k === 'q'; cx.font = (ital ? 'italic ' : '') + (bold ? '700 ' : '400 ') + size + 'px ' + FAM; cx.textBaseline = 'alphabetic'; cx.direction = isR ? 'rtl' : 'ltr'; cx.textAlign = isR ? 'right' : 'left';
      var lines = [], cur = ''; txt.split('\n').forEach(function(par){ cur = ''; par.split(' ').forEach(function(w){ var t = cur ? cur + ' ' + w : w; if(cx.measureText(t).width > maxW && cur){ lines.push(cur); cur = w; } else cur = t; }); lines.push(cur); });
      var pre = k === 'li' ? (b.num ? b.num + '. ' : '• ') : '';
      lines.forEach(function(ln, li){ if(y + lead > H - MB * S) np(); cx.font = (ital ? 'italic ' : '') + (bold ? '700 ' : '400 ') + size + 'px ' + FAM; cx.direction = isR ? 'rtl' : 'ltr'; cx.textAlign = isR ? 'right' : 'left'; cx.fillStyle = k === 'small' ? '#777' : '#111'; y += lead; if(li === 0 && pre && !isR){ cx.fillText(pre, MX * S + 4 * S, y); } cx.fillText(ln, isR ? (PW - MX) * S : left, y); });
      y += (k === 'h1' ? 10 : k === 'li' ? 2 : 6) * S; });
    var imgJobs = doc.blocks.filter(function(b){ return b.__pos; }).map(function(b){ return new Promise(function(res){ var u = URL.createObjectURL(new Blob([b.jpeg.bytes], { type: 'image/jpeg' })), im = new Image(); im.onload = function(){ b.__pos.cv.getContext('2d').drawImage(im, b.__pos.x, b.__pos.y, b.__pos.w, b.__pos.h); URL.revokeObjectURL(u); res(); }; im.onerror = function(){ res(); }; im.src = u; }); });
    return Promise.all(imgJobs).then(function(){ return Promise.all(pages.map(function(c){ return new Promise(function(res){ c.toBlob(function(b){ b.arrayBuffer().then(function(ab){ res({ bytes: new Uint8Array(ab), w: c.width, h: c.height }); }); }, 'image/jpeg', 0.9); }); })); }).then(function(imgs){
      var pgs = imgs.map(function(im){ return { imgs: [im], ops: ['q ' + PW.toFixed(2) + ' 0 0 ' + PH.toFixed(2) + ' 0 0 cm /Im1 Do Q'] }; }); return assemble(pgs, false); }); }
  function pdf(doc){ if(needsRaster(doc)) return rasterPdf(doc); return Promise.resolve(assemble(layout(doc), true)); }
  function make(doc, kind){ return prepare(doc).then(function(d){ return kind === 'docx' ? docx(d) : pdf(d); }); }
  return { fromText: fromText, fromHtml: fromHtml, make: make, run: run, FOOT: FOOT };
})();
