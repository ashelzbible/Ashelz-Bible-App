/* Creator tools for the Studio: text styles (fonts, sizes, bold, italic, alignment, colour), an emoji panel, and the picture editor with filters, text, emoji and stickers.
   Everything runs on the phone. Fonts are the ones already on the phone, so nothing is downloaded. */
window.CreatorTools = (function(){
  var FONTS = [['classic', 'Classic', 'Georgia,"Times New Roman",serif'], ['clean', 'Clean', 'system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif'], ['script', 'Script', '"Brush Script MT","Segoe Script","Snell Roundhand","Apple Chancery",cursive'], ['bold', 'Bold', 'Impact,"Arial Black","Helvetica Neue",sans-serif'], ['type', 'Typewriter', '"Courier New",Courier,monospace'], ['elegant', 'Elegant', '"Palatino Linotype",Palatino,"Book Antiqua",serif']];
  var SIZES = [['s', 'Small', 0.9], ['m', 'Normal', 1.05], ['l', 'Large', 1.3], ['xl', 'Huge', 1.7]];
  var COLORS = ['', '#f6c453', '#4aa3ff', '#ff6b81', '#3ddc84', '#c792ea', '#ffffff', '#111111'];
  var EMOJI = '🙏 ✝️ ❤️ 🕊️ 🔥 ✨ 🌟 ⭐ 🌅 🌄 🌈 ☀️ 🌙 ☁️ 🌿 🌸 🌹 🌻 🌾 🍇 🍞 🕯️ 📖 📜 🎶 🎵 🎤 🙌 👏 💪 😊 😇 🥰 😍 😭 🤗 😌 😀 🙂 😉 😂 🥹 👑 🏆 🎁 🎉 💡 🗝️ ⚓ 🛡️ ⚔️ 🏠 ⛪ 🌍 🌊 ⛰️ 🐑 🦁 🐑 🕎 ✋ 👣 💫 💛 💙 💜 🤍 🧡 💚 ☮️ 🔔 🕊 📿 🧎 🫶 🤲'.split(' ').filter(function(x, i, a){ return x && a.indexOf(x) === i; });
  var STICKERS = [['Amen 🙏', '#ffb347', '#ff7e5f'], ['God is good', '#43cea2', '#185a9d'], ['Blessed', '#f6d365', '#fda085'], ['Hallelujah!', '#a18cd1', '#e08bb5'], ['Faith over fear', '#0f2027', '#2c5364'], ['Jesus loves you', '#ee0979', '#ff6a00'], ['Pray 🙏', '#4facfe', '#00b4d8'], ['Grace ✝️', '#f7971e', '#d4a017'], ['Shalom', '#11998e', '#2bb673'], ['Be still', '#667eea', '#764ba2'], ['Trust Him', '#fc4a1a', '#d98c10'], ['Joy 😊', '#ff758c', '#ff7eb3']];
  var FILTERS = [['none', 'Normal'], ['warm', 'Warm'], ['cool', 'Cool'], ['bw', 'Black and white'], ['sepia', 'Sepia'], ['vivid', 'Vivid'], ['fade', 'Fade'], ['golden', 'Golden'], ['drama', 'Dramatic'], ['glow', 'Soft glow']];
  function find(list, k){ for(var i = 0; i < list.length; i++) if(list[i][0] === k) return list[i]; return list[0]; }
  function fam(k){ return find(FONTS, k)[2]; }
  /* the CSS for a saved text style; used by the Studio, the Devotions page and the editor */
  function styleCss(st){ st = st || {}; var sz = find(SIZES, st.s || 'm')[2]; return 'font-family:' + fam(st.f || 'classic') + ';font-size:' + sz + 'rem;font-weight:' + (st.b ? '700' : '400') + ';font-style:' + (st.i ? 'italic' : 'normal') + ';text-align:' + (st.a || 'left') + (st.c ? ';color:' + st.c : '') + ';white-space:pre-wrap'; }
  function isPlain(st){ return !st || (!st.f || st.f === 'classic') && (!st.s || st.s === 'm') && !st.b && !st.i && (!st.a || st.a === 'left') && !st.c; }

  /* ---- emoji panel and style bar for a textarea ---- */
  function emojiPanel(h, onPick){ var box = h('div', { class: 'emojipanel', role: 'group', 'aria-label': 'Emoji' }); EMOJI.forEach(function(e){ box.appendChild(h('button', { type: 'button', class: 'emo', 'aria-label': 'Emoji ' + e, onclick: function(){ onPick(e); } }, e)); }); return box; }
  function insertAt(ta, text){ var s = ta.selectionStart == null ? ta.value.length : ta.selectionStart, e = ta.selectionEnd == null ? s : ta.selectionEnd; ta.value = ta.value.slice(0, s) + text + ta.value.slice(e); var p = s + text.length; try { ta.focus(); ta.setSelectionRange(p, p); } catch(x) {} ta.dispatchEvent(new Event('input', { bubbles: true })); }
  function styleBar(h, ta, st, onChange){
    function apply(){ ta.setAttribute('style', styleCss(st)); onChange && onChange(st); }
    var font = h('select', { 'aria-label': 'Font', class: 'tb-font' }, FONTS.map(function(f){ return h('option', { value: f[0] }, f[1]); })), size = h('select', { 'aria-label': 'Text size', class: 'tb-size' }, SIZES.map(function(f){ return h('option', { value: f[0] }, f[1]); }));
    font.value = st.f || 'classic'; size.value = st.s || 'm';
    font.addEventListener('change', function(){ st.f = font.value; apply(); }); size.addEventListener('change', function(){ st.s = size.value; apply(); });
    var bold = h('button', { type: 'button', class: 'btn ghost sm tb-b', 'aria-pressed': String(!!st.b), 'aria-label': 'Bold', onclick: function(){ st.b = st.b ? 0 : 1; bold.setAttribute('aria-pressed', String(!!st.b)); apply(); } }, h('b', {}, 'B')),
      ital = h('button', { type: 'button', class: 'btn ghost sm tb-i', 'aria-pressed': String(!!st.i), 'aria-label': 'Italic', onclick: function(){ st.i = st.i ? 0 : 1; ital.setAttribute('aria-pressed', String(!!st.i)); apply(); } }, h('i', {}, 'I')),
      al = h('button', { type: 'button', class: 'btn ghost sm tb-a', 'aria-label': 'Align text', onclick: function(){ var o = ['left', 'center', 'right'], n = o[(o.indexOf(st.a || 'left') + 1) % 3]; st.a = n; al.textContent = n === 'left' ? '⇤ Left' : n === 'center' ? '↔ Centre' : 'Right ⇥'; apply(); } }, st.a === 'center' ? '↔ Centre' : st.a === 'right' ? 'Right ⇥' : '⇤ Left');
    var sw = h('div', { class: 'tb-colors', role: 'group', 'aria-label': 'Text colour' }, COLORS.map(function(c){ return h('button', { type: 'button', class: 'swatch' + ((st.c || '') === c ? ' on' : ''), 'aria-label': c ? 'Colour ' + c : 'Normal colour', style: 'background:' + (c || 'linear-gradient(135deg,#fff 50%,#222 50%)'), onclick: function(){ st.c = c; Array.prototype.forEach.call(sw.children, function(x){ x.classList.remove('on'); }); this.classList.add('on'); apply(); } }); }));
    var panel = h('div', { style: 'display:none' }, emojiPanel(h, function(e){ insertAt(ta, e); })), eb = h('button', { type: 'button', class: 'btn ghost sm tb-emoji', 'aria-expanded': 'false', onclick: function(){ var open = panel.style.display === 'none'; panel.style.display = open ? '' : 'none'; eb.setAttribute('aria-expanded', String(open)); } }, '😀 Emoji');
    apply();
    return h('div', { class: 'stylebar' }, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;justify-content:flex-start' }, font, size, bold, ital, al, eb), sw, panel);
  }

  /* ---- picture filters (pixel maths, so they work on every phone) ---- */
  function applyFilter(cv, key){ if(key === 'none') return; var cx = cv.getContext('2d'), im = cx.getImageData(0, 0, cv.width, cv.height), d = im.data, n = d.length;
    var P = { warm: { r: 1.1, g: 1.02, b: 0.88, br: 6 }, cool: { r: 0.9, g: 1.0, b: 1.12, br: 4 }, vivid: { sat: 1.45, con: 1.1 }, fade: { con: 0.82, br: 22, sat: 0.85 }, golden: { r: 1.14, g: 1.05, b: 0.82, sat: 1.15, br: 8 }, drama: { con: 1.35, sat: 0.8, br: -8 }, glow: { br: 14, con: 0.9, sat: 1.1 } }[key] || {};
    for(var i = 0; i < n; i += 4){ var r = d[i], g = d[i + 1], b = d[i + 2], l = 0.299 * r + 0.587 * g + 0.114 * b;
      if(key === 'bw'){ r = g = b = l; }
      else if(key === 'sepia'){ var nr = 0.393 * r + 0.769 * g + 0.189 * b, ng = 0.349 * r + 0.686 * g + 0.168 * b, nb = 0.272 * r + 0.534 * g + 0.131 * b; r = nr; g = ng; b = nb; }
      else { if(P.sat){ r = l + (r - l) * P.sat; g = l + (g - l) * P.sat; b = l + (b - l) * P.sat; }
        if(P.con){ r = (r - 128) * P.con + 128; g = (g - 128) * P.con + 128; b = (b - 128) * P.con + 128; }
        if(P.r){ r *= P.r; g *= P.g; b *= P.b; } if(P.br){ r += P.br; g += P.br; b += P.br; } }
      d[i] = r < 0 ? 0 : r > 255 ? 255 : r; d[i + 1] = g < 0 ? 0 : g > 255 ? 255 : g; d[i + 2] = b < 0 ? 0 : b > 255 ? 255 : b; }
    cx.putImageData(im, 0, 0); }

  /* ---- the picture editor ---- */
  function openPicStudio(h, blob, done, toast){
    var url = URL.createObjectURL(blob), img = new Image();
    img.onerror = function(){ URL.revokeObjectURL(url); toast('Could not open that picture'); };
    img.onload = function(){ URL.revokeObjectURL(url); build(img); };
    img.src = url;
    function build(img){
      var s = Math.min(1, 1280 / Math.max(img.width, img.height)), W = Math.round(img.width * s), H = Math.round(img.height * s);
      var base = document.createElement('canvas'); base.width = W; base.height = H; base.getContext('2d').drawImage(img, 0, 0, W, H);
      var filt = document.createElement('canvas'), fkey = 'none', layers = [], sel = -1;
      function refilter(){ filt.width = W; filt.height = H; var c = filt.getContext('2d'); c.drawImage(base, 0, 0); applyFilter(filt, fkey); }
      refilter();
      var cv = h('canvas', { class: 'pscanvas', width: W, height: H, 'aria-label': 'Picture being edited' }), cx = cv.getContext('2d');
      function lines(L){ return String(L.text || '').split('\n'); }
      function draw(ctx, forExport){
        ctx.clearRect(0, 0, W, H); ctx.drawImage(filt, 0, 0);
        layers.forEach(function(L, idx){ var fs = L.size * W, fm = (L.italic ? 'italic ' : '') + (L.bold ? '700 ' : '400 ') + fs + 'px ' + fam(L.font), ls = lines(L), lh = fs * 1.2;
          ctx.save(); ctx.translate(L.x * W, L.y * H); ctx.rotate(L.rot * Math.PI / 180); ctx.font = fm; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          var mw = 0; ls.forEach(function(t){ mw = Math.max(mw, ctx.measureText(t).width); }); var pad = fs * 0.35, bw = mw + pad * 2, bh = lh * ls.length + pad; L._w = bw; L._h = bh;
          if(L.badge || L.style === 'box'){ var g; if(L.badge){ g = ctx.createLinearGradient(-bw / 2, -bh / 2, bw / 2, bh / 2); g.addColorStop(0, L.badge[0]); g.addColorStop(1, L.badge[1]); } else g = 'rgba(0,0,0,0.55)';
            ctx.fillStyle = g; var r = Math.min(bh / 2, fs * 0.5); ctx.beginPath(); ctx.moveTo(-bw / 2 + r, -bh / 2); ctx.arcTo(bw / 2, -bh / 2, bw / 2, bh / 2, r); ctx.arcTo(bw / 2, bh / 2, -bw / 2, bh / 2, r); ctx.arcTo(-bw / 2, bh / 2, -bw / 2, -bh / 2, r); ctx.arcTo(-bw / 2, -bh / 2, bw / 2, -bh / 2, r); ctx.closePath(); ctx.fill();
            if(L.badge){ ctx.lineWidth = fs * 0.06; ctx.strokeStyle = 'rgba(255,255,255,0.85)'; ctx.stroke(); } }
          ls.forEach(function(t, k){ var y = (k - (ls.length - 1) / 2) * lh;
            if(L.style === 'shadow'){ ctx.shadowColor = 'rgba(0,0,0,0.75)'; ctx.shadowBlur = fs * 0.18; ctx.shadowOffsetY = fs * 0.05; }
            if(L.style === 'outline'){ ctx.lineJoin = 'round'; ctx.lineWidth = Math.max(2, fs * 0.14); ctx.strokeStyle = (L.color === '#111111' ? '#ffffff' : '#111111'); ctx.strokeText(t, 0, y); }
            ctx.fillStyle = L.badge ? '#ffffff' : L.color; ctx.fillText(t, 0, y); ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0; });
          if(!forExport && idx === sel){ ctx.setLineDash([fs * 0.2, fs * 0.15]); ctx.lineWidth = Math.max(2, W / 300); ctx.strokeStyle = '#f6c453'; ctx.strokeRect(-bw / 2, -bh / 2, bw, bh); }
          ctx.restore(); }); }
      function redraw(){ draw(cx, false); }
      function hit(px, py){ for(var i = layers.length - 1; i >= 0; i--){ var L = layers[i], dx = px - L.x * W, dy = py - L.y * H, a = -L.rot * Math.PI / 180, lx = dx * Math.cos(a) - dy * Math.sin(a), ly = dx * Math.sin(a) + dy * Math.cos(a); if(Math.abs(lx) <= (L._w || 40) / 2 + 10 && Math.abs(ly) <= (L._h || 40) / 2 + 10) return i; } return -1; }
      var drag = null;
      function pt(e){ var r = cv.getBoundingClientRect(); return [(e.clientX - r.left) * W / r.width, (e.clientY - r.top) * H / r.height]; }
      cv.addEventListener('pointerdown', function(e){ var p = pt(e), i = hit(p[0], p[1]); sel = i; syncPanel(); redraw(); if(i > -1){ drag = { i: i, dx: layers[i].x * W - p[0], dy: layers[i].y * H - p[1] }; try { cv.setPointerCapture(e.pointerId); } catch(x) {} e.preventDefault(); } });
      cv.addEventListener('pointermove', function(e){ if(!drag) return; var p = pt(e), L = layers[drag.i]; L.x = Math.max(0, Math.min(1, (p[0] + drag.dx) / W)); L.y = Math.max(0, Math.min(1, (p[1] + drag.dy) / H)); redraw(); e.preventDefault(); });
      ['pointerup', 'pointercancel'].forEach(function(ev){ cv.addEventListener(ev, function(){ drag = null; }); });
      function add(L){ layers.push(L); sel = layers.length - 1; syncPanel(); redraw(); }
      function newText(t){ return { text: t || 'Your words', x: 0.5, y: 0.5, size: 0.08, rot: 0, font: 'bold', color: '#ffffff', bold: 0, italic: 0, style: 'shadow' }; }
      /* controls */
      var fchips = h('div', { class: 'psfilters', role: 'group', 'aria-label': 'Filters' }, FILTERS.map(function(f){ return h('button', { type: 'button', class: 'chip' + (f[0] === 'none' ? ' on' : ''), 'data-filter': f[0], onclick: function(){ fkey = f[0]; Array.prototype.forEach.call(fchips.children, function(x){ x.classList.toggle('on', x === this); }, this); refilter(); redraw(); } }, f[1]); }));
      var tin = h('textarea', { rows: '2', class: 'ps-text', 'aria-label': 'Text on the picture', placeholder: 'Type your words' }), fsel = h('select', { class: 'ps-font', 'aria-label': 'Font' }, FONTS.map(function(f){ return h('option', { value: f[0] }, f[1]); })),
        ssel = h('select', { class: 'ps-style', 'aria-label': 'Text style' }, [['plain', 'Plain'], ['shadow', 'Shadow'], ['outline', 'Outline'], ['box', 'Box']].map(function(f){ return h('option', { value: f[0] }, f[1]); })),
        size = h('input', { type: 'range', min: '3', max: '30', value: '8', class: 'ps-size', 'aria-label': 'Size' }), rot = h('input', { type: 'range', min: '-45', max: '45', value: '0', class: 'ps-rot', 'aria-label': 'Turn' }),
        bold = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Bold', 'aria-pressed': 'false' }, h('b', {}, 'B')), ital = h('button', { type: 'button', class: 'btn ghost sm', 'aria-label': 'Italic', 'aria-pressed': 'false' }, h('i', {}, 'I')),
        del = h('button', { type: 'button', class: 'btn ghost sm ps-del', onclick: function(){ if(sel > -1){ layers.splice(sel, 1); sel = -1; syncPanel(); redraw(); } } }, 'Remove this'),
        cols = h('div', { class: 'tb-colors' }, COLORS.slice(1).map(function(c){ return h('button', { type: 'button', class: 'swatch', 'aria-label': 'Colour ' + c, style: 'background:' + c, onclick: function(){ var L = layers[sel]; if(L && !L.badge){ L.color = c; redraw(); } } }); }));
      var panel = h('div', { class: 'pspanel card', style: 'display:none' }, tin, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;justify-content:flex-start;margin:6px 0' }, fsel, ssel, bold, ital), h('label', { class: 'note' }, 'Size'), size, h('label', { class: 'note' }, 'Turn'), rot, cols, del);
      function cur(){ return layers[sel]; }
      function syncPanel(){ var L = cur(); panel.style.display = L ? '' : 'none'; if(!L) return; tin.value = L.text; fsel.value = L.font; ssel.value = L.style === 'badge' ? 'plain' : L.style; size.value = String(Math.round(L.size * 100)); rot.value = String(L.rot); bold.setAttribute('aria-pressed', String(!!L.bold)); ital.setAttribute('aria-pressed', String(!!L.italic)); tin.style.display = L.emoji ? 'none' : ''; fsel.style.display = L.emoji || L.badge ? 'none' : ''; ssel.style.display = L.emoji || L.badge ? 'none' : ''; cols.style.display = L.emoji || L.badge ? 'none' : ''; }
      tin.addEventListener('input', function(){ if(cur()){ cur().text = tin.value; redraw(); } }); fsel.addEventListener('change', function(){ if(cur()){ cur().font = fsel.value; redraw(); } }); ssel.addEventListener('change', function(){ if(cur()){ cur().style = ssel.value; redraw(); } });
      size.addEventListener('input', function(){ if(cur()){ cur().size = size.value / 100; redraw(); } }); rot.addEventListener('input', function(){ if(cur()){ cur().rot = +rot.value; redraw(); } });
      bold.addEventListener('click', function(){ var L = cur(); if(L){ L.bold = L.bold ? 0 : 1; syncPanel(); redraw(); } }); ital.addEventListener('click', function(){ var L = cur(); if(L){ L.italic = L.italic ? 0 : 1; syncPanel(); redraw(); } });
      var emo = h('div', { class: 'psgrid', style: 'display:none' }, EMOJI.map(function(e){ return h('button', { type: 'button', class: 'emo', 'aria-label': 'Add emoji ' + e, onclick: function(){ var L = newText(e); L.emoji = 1; L.size = 0.16; L.style = 'plain'; L.font = 'clean'; add(L); } }, e); }));
      var stk = h('div', { class: 'psgrid stk', style: 'display:none' }, STICKERS.map(function(t){ return h('button', { type: 'button', class: 'stickerbtn', style: 'background:linear-gradient(135deg,' + t[1] + ',' + t[2] + ')', onclick: function(){ var L = newText(t[0]); L.badge = [t[1], t[2]]; L.size = 0.07; L.font = 'bold'; L.style = 'plain'; L.color = '#ffffff'; add(L); } }, t[0]); }));
      function toggle(box){ [emo, stk].forEach(function(b){ b.style.display = b === box && b.style.display === 'none' ? '' : 'none'; }); }
      var bar = h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-start' }, h('button', { type: 'button', class: 'btn ghost', 'data-add': 'text', onclick: function(){ add(newText()); } }, 'Aa Text'), h('button', { type: 'button', class: 'btn ghost', 'data-add': 'emoji', onclick: function(){ toggle(emo); } }, '😀 Emoji'), h('button', { type: 'button', class: 'btn ghost', 'data-add': 'sticker', onclick: function(){ toggle(stk); } }, '✨ Stickers'));
      var wrap = h('div', { class: 'pstudio', role: 'dialog', 'aria-label': 'Picture editor' });
      function close(){ wrap.remove(); document.body.style.overflow = ''; }
      var cancel = h('button', { type: 'button', class: 'btn ghost', 'data-ps': 'cancel', onclick: close }, 'Cancel'), ok = h('button', { type: 'button', class: 'btn', 'data-ps': 'done', onclick: function(){ sel = -1; var ex = document.createElement('canvas'); ex.width = W; ex.height = H; draw(ex.getContext('2d'), true); ex.toBlob(function(b){ if(!b){ toast('Could not save the picture'); return; } close(); done(b); }, 'image/jpeg', 0.88); } }, 'Done');
      wrap.append(h('div', { class: 'psbar' }, cancel, h('b', {}, 'Edit picture'), ok), h('div', { class: 'pscanvaswrap' }, cv), h('div', { class: 'stack', style: 'padding:10px 12px 40px' }, fchips, bar, emo, stk, panel));
      document.body.appendChild(wrap); document.body.style.overflow = 'hidden'; redraw();
      wrap.__api = { layers: layers, add: add, newText: newText, setFilter: function(k){ fkey = k; refilter(); redraw(); } };
    }
  }
  return { FONTS: FONTS, SIZES: SIZES, EMOJI: EMOJI, STICKERS: STICKERS, FILTERS: FILTERS, styleCss: styleCss, isPlain: isPlain, styleBar: styleBar, emojiPanel: emojiPanel, insertAt: insertAt, openPicStudio: openPicStudio, applyFilter: applyFilter };
})();
