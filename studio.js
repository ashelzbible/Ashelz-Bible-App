/* Creator Studio: lets the app's developer write, record or upload her own devotions and publish them to the Devotions page and the Online Homecell.
   There is no server. Posts are saved as files in the app's own GitHub repository (posts/feed.json plus one folder per post), using a fine grained token that stays on her device only.
   Everyone else just reads posts/feed.json, so the same address works for all readers. Pages can take a minute or two to show a new post. */
window.StudioKit = function(E){
  var h = E.h, toast = E.toast, load = E.load, save = E.save, KEY = 'woh_studio_v1', FEEDKEY = 'woh_feedcache_v1';
  var MAX_VIDEO = 30 * 1024 * 1024, MAX_SECONDS = 120, FEED = 'posts/feed.json';
  /* Developer sign in. Only a salted PBKDF2 hash is kept here, never the password itself. This stops other people opening the Studio screen; the real lock on publishing is the GitHub token that only the developer's device holds. */
  var DEV0 = { salt: '3100139f90c1c10285dde875969d5179', hash: 'd0f9b2f04e9a8d77923e4e05b6441dece4556b44538af828d4061037bcaca91e', iter: 250000 }, SESS = 'woh_studio_ok', FAILKEY = 'woh_studio_fail';
  var CREDKEY = 'woh_studio_cred';
  function DEVC(){ var o = load(CREDKEY, null); return o && o.salt && o.hash ? o : DEV0; }
  function hex(b){ return Array.prototype.map.call(new Uint8Array(b), function(x){ return ('0' + x.toString(16)).slice(-2); }).join(''); }
  function unhex(s){ var o = new Uint8Array(s.length / 2); for(var i = 0; i < o.length; i++) o[i] = parseInt(s.substr(i * 2, 2), 16); return o; }
  function derive(user, pass, c0){ c0 = c0 || DEVC(); var enc = new TextEncoder(); return crypto.subtle.importKey('raw', enc.encode(user.trim().toLowerCase() + '\n' + pass), 'PBKDF2', false, ['deriveBits']).then(function(k){ return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unhex(c0.salt), iterations: c0.iter, hash: 'SHA-256' }, k, 256); }).then(hex); }
  function unlocked(){ try { return sessionStorage.getItem(SESS) === DEVC().hash.slice(0, 16); } catch(e) { return false; } }
  function lockNow(){ try { sessionStorage.removeItem(SESS); } catch(e) {} }
  function Login(go){
    var u = h('input', { type: 'email', id: 'dv-user', placeholder: 'Developer email', autocomplete: 'username', 'aria-label': 'Developer email' }), p = h('input', { type: 'password', id: 'dv-pass', placeholder: 'Password', autocomplete: 'current-password', 'aria-label': 'Password' }), msg = h('p', { class: 'note', id: 'dv-msg', role: 'status' });
    function tryIn(){ var f = load(FAILKEY, { n: 0, until: 0 }); if(Date.now() < f.until){ msg.textContent = 'Too many tries. Wait ' + Math.ceil((f.until - Date.now()) / 1000) + ' seconds.'; return; }
      if(!(window.crypto && crypto.subtle)){ msg.textContent = 'Sign in needs a secure (https) connection.'; return; }
      derive(u.value, p.value).then(function(d){ if(d === DEVC().hash){ save(FAILKEY, { n: 0, until: 0 }); try { sessionStorage.setItem(SESS, DEVC().hash.slice(0, 16)); } catch(e) {} p.value = ''; go('studio'); }
        else { f.n++; f.until = f.n >= 5 ? Date.now() + Math.min(900000, 30000 * (f.n - 4)) : 0; save(FAILKEY, f); msg.textContent = 'That email or password is not right.'; p.value = ''; }
      }, function(){ msg.textContent = 'Could not check the sign in on this device.'; }); }
    p.addEventListener('keydown', function(e){ if(e.key === 'Enter') tryIn(); });
    return E.page('Creator Studio', 'play', go, h('div', { class: 'stack narrow' }, h('div', { class: 'card' }, h('div', { class: 'ch' }, h('span', { class: 'ic' }, E.icon('account')), 'Developer sign in'), h('p', { class: 'note' }, 'This area is only for the app developer. Readers do not need to sign in to read, watch or download devotions.'), u, p, h('button', { class: 'btn block', type: 'button', id: 'dv-go', style: 'margin-top:10px', onclick: tryIn }, 'Sign in'), msg)));
  }
  function cfg(){ var c = load(KEY, {}), a = window.APPCFG || {}; if(c.repo === 'ashelzbible/Ashelz-Bible-App' && a.publishRepo) c.repo = ''; return { repo: c.repo || a.publishRepo || '', branch: c.branch || a.publishBranch || 'main', token: c.token || '' }; }
  function esc(s){ return String(s == null ? '' : s); }
  function newId(){ var d = new Date(), p = function(n){ return ('0' + n).slice(-2); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); }

  /* ---------- reading the feed (everyone) ---------- */
  function cached(){ var c = load(FEEDKEY, null); return c && c.posts ? c.posts : []; }
  function fetchFeed(){ return fetch(FEED + '?t=' + Date.now(), { cache: 'no-store' }).then(function(r){ if(!r.ok) throw 0; return r.json(); }).then(function(j){
    var posts = (j && j.posts || []).filter(function(p){ return p && p.id && p.title; }).sort(function(a, b){ return a.id < b.id ? 1 : -1; });
    save(FEEDKEY, { posts: posts }); return posts; }).catch(function(){ return cached(); }); }

  /* ---------- saving to the phone ---------- */
  function postText(p){ return p.title + (p.ref ? '\n' + p.ref : '') + '\n\n' + (p.body || '') + '\n\n— Ashelz Bible App'; }
  function fileOf(p, key){ return p[key] ? p[key] : ''; }
  function download(url, name){ return fetch(url).then(function(r){ if(!r.ok) throw 0; return r.blob(); }).then(function(b){ E.saveBlob(b, name); toast('Downloaded'); }).catch(function(){ var a = h('a', { href: url, download: name, target: '_blank', rel: 'noopener' }); document.body.appendChild(a); a.click(); a.remove(); }); }
  function ext(u){ var m = /\.([a-z0-9]{2,4})(?:\?|$)/i.exec(u); return m ? m[1] : 'bin'; }

  /* ---------- how one post looks (Devotions page, Homecell page, Studio list) ---------- */
  function PostCard(p, extra){
    var kids = [h('div', { class: 'ch' }, h('span', { class: 'ic' }, E.icon('play')), p.title), h('p', { class: 'note', style: 'margin-top:-4px' }, 'From Ashelz · ' + (p.at ? new Date(p.at).toDateString().slice(0, 10) : ''))];
    if(p.ref) kids.push(h('p', { class: 'note' }, p.ref));
    if(p.video) kids.push(h('video', { class: 'postmedia', src: p.video, controls: true, playsinline: true, preload: 'metadata', 'aria-label': 'Video: ' + p.title, style: 'width:100%;max-height:420px;border-radius:12px;background:#000' }));
    if(p.image) kids.push(h('img', { class: 'postmedia', src: p.image, alt: p.title, loading: 'lazy', style: 'width:100%;border-radius:12px;display:block' }));
    if(p.body) kids.push(h('p', { class: 'selectable', style: 'white-space:pre-wrap;margin-top:8px' }, p.body));
    var row = [h('button', { class: 'btn ghost sm', type: 'button', 'data-dl': 'text', onclick: function(){ E.saveBlob(new Blob([postText(p)], { type: 'text/plain' }), 'ashelz-' + p.id + '.txt'); toast('Text downloaded'); } }, 'Download text')];
    if(p.image) row.push(h('button', { class: 'btn ghost sm', type: 'button', 'data-dl': 'image', onclick: function(){ download(p.image, 'ashelz-' + p.id + '.' + ext(p.image)); } }, 'Download image'));
    if(p.video) row.push(h('button', { class: 'btn ghost sm', type: 'button', 'data-dl': 'video', onclick: function(){ download(p.video, 'ashelz-' + p.id + '.' + ext(p.video)); } }, 'Download video'));
    row.push(h('button', { class: 'btn ghost sm', type: 'button', onclick: function(){ E.share(postText(p)); } }, 'Share'));
    kids.push(h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;justify-content:flex-start;margin-top:10px' }, row));
    if(extra) kids.push(extra);
    return h('div', { class: 'card postcard', 'data-post': p.id }, kids);
  }
  /* a block for the Devotions page and one for the Homecell page; each loads its posts when it is shown */
  function Block(title, filter, note){
    var box = h('div', { class: 'stack postblock', 'data-block': title }), wrap = h('div', { class: 'stack' }, h('h2', { style: 'font-size:1.1rem;margin:4px 0 0' }, title), box);
    function paint(all){ var list = all.filter(filter).slice(0, 8); box.innerHTML = ''; if(!list.length){ wrap.style.display = 'none'; return; } wrap.style.display = '';
      if(note) box.appendChild(h('p', { class: 'note' }, note)); list.forEach(function(p){ box.appendChild(PostCard(p)); }); }
    paint(cached());          /* what this phone already knows shows at once */
    fetchFeed().then(paint);  /* then the newest list replaces it */
    return wrap;
  }

  /* ---------- publishing to GitHub (developer only) ---------- */
  function api(path, opt){ var c = cfg(); opt = opt || {}; opt.headers = { 'Accept': 'application/vnd.github+json', 'Authorization': 'Bearer ' + c.token, 'X-GitHub-Api-Version': '2022-11-28' }; if(opt.body){ opt.headers['Content-Type'] = 'application/json'; }
    return fetch('https://api.github.com/repos/' + c.repo + '/contents/' + path + (opt.q || ''), opt).then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if(!r.ok){ var e = new Error(j.message || ('GitHub error ' + r.status)); e.status = r.status; throw e; } return j; }); }); }
  function b64(blob){ return new Promise(function(res, rej){ var f = new FileReader(); f.onload = function(){ res(String(f.result).split(',')[1] || ''); }; f.onerror = rej; f.readAsDataURL(blob); }); }
  function b64text(s){ return btoa(unescape(encodeURIComponent(s))); }
  function fromB64(s){ return decodeURIComponent(escape(atob(String(s).replace(/\s/g, '')))); }
  /* uploads use XMLHttpRequest so the screen can show real progress, and give up with a clear message instead of waiting for ever */
  function putFile(path, content64, message, sha, onProgress){ var c = cfg(), body = { message: message, content: content64, branch: c.branch }; if(sha) body.sha = sha;
    return new Promise(function(res, rej){ var x = new XMLHttpRequest(); x.open('PUT', 'https://api.github.com/repos/' + c.repo + '/contents/' + path); x.timeout = 300000;
      x.setRequestHeader('Accept', 'application/vnd.github+json'); x.setRequestHeader('Authorization', 'Bearer ' + c.token); x.setRequestHeader('X-GitHub-Api-Version', '2022-11-28'); x.setRequestHeader('Content-Type', 'application/json');
      if(x.upload && onProgress) x.upload.onprogress = function(e){ if(e.lengthComputable) onProgress(Math.round(e.loaded * 100 / e.total)); };
      x.onload = function(){ var j = {}; try { j = JSON.parse(x.responseText); } catch(e) {} if(x.status >= 200 && x.status < 300) res(j); else { var er = new Error(j.message || ('GitHub error ' + x.status)); er.status = x.status; rej(er); } };
      x.onerror = function(){ var er = new Error('The connection to GitHub failed. Check the internet and try again.'); er.status = 0; rej(er); };
      x.ontimeout = function(){ var er = new Error('The upload took too long. Try a shorter or smaller video, or a better connection.'); er.status = 0; rej(er); };
      x.send(JSON.stringify(body)); }); }
  function getFeedRemote(){ var c = cfg(); return api(FEED, { q: '?ref=' + encodeURIComponent(c.branch) + '&t=' + Date.now() }).then(function(j){ var o; try { o = JSON.parse(fromB64(j.content)); } catch(e) { o = {}; } return { sha: j.sha, data: { posts: o.posts || [] } }; }, function(e){ if(e.status === 404) return { sha: '', data: { posts: [] } }; throw e; }); }
  /* change the feed with a function; retries once if another change landed first */
  function editFeed(fn, message){ function once(){ return getFeedRemote().then(function(cur){ var out = fn(cur.data); return putFile(FEED, b64text(JSON.stringify(out, null, 1)), message, cur.sha).then(function(){ return out; }); }); }
    return once().catch(function(e){ if(e.status === 409 || e.status === 422) return once(); throw e; }); }
  function publish(p, files, onStep){ var base = 'posts/' + p.id + '/', chain = Promise.resolve();
    files.forEach(function(f){ chain = chain.then(function(){ onStep('Preparing ' + f.label + '...'); return b64(f.blob).then(function(d){ onStep('Uploading ' + f.label + ' (' + (f.blob.size / 1048576).toFixed(1) + ' MB) 0%'); return putFile(base + f.name, d, 'Post media: ' + p.title, '', function(pc){ onStep('Uploading ' + f.label + ' (' + (f.blob.size / 1048576).toFixed(1) + ' MB) ' + pc + '%' + (pc >= 100 ? ', waiting for GitHub...' : '')); }); }); }); });
    return chain.then(function(){ onStep('Adding to the Devotions page...'); return editFeed(function(d){ d.posts = d.posts.filter(function(x){ return x.id !== p.id; }); d.posts.unshift(p); return d; }, 'Post: ' + p.title); }); }
  function removePost(p){ return editFeed(function(d){ d.posts = d.posts.filter(function(x){ return x.id !== p.id; }); return d; }, 'Remove post: ' + p.title).then(function(){
    return Promise.all(['image', 'video'].map(function(k){ if(!p[k]) return null; var path = p[k]; return api(path, { q: '?ref=' + encodeURIComponent(cfg().branch) }).then(function(j){ return api(path, { method: 'DELETE', body: JSON.stringify({ message: 'Remove post media', sha: j.sha, branch: cfg().branch }) }); }).catch(function(){}); })); }); }
  function setHomecell(p, on){ return editFeed(function(d){ d.posts.forEach(function(x){ if(x.id === p.id) x.homecell = on; }); return d; }, (on ? 'Push to Homecell: ' : 'Take off Homecell: ') + p.title); }

  /* ---------- picture and video preparation ---------- */
  function shrinkImage(file){ return new Promise(function(res, rej){ var url = URL.createObjectURL(file), im = new Image(); im.onload = function(){ var s = Math.min(1, 1280 / Math.max(im.width, im.height)), cv = document.createElement('canvas'); cv.width = Math.round(im.width * s); cv.height = Math.round(im.height * s); cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height); URL.revokeObjectURL(url); cv.toBlob(function(b){ b ? res(b) : rej(new Error('Could not read that picture')); }, 'image/jpeg', 0.82); }; im.onerror = function(){ URL.revokeObjectURL(url); rej(new Error('Could not read that picture')); }; im.src = url; }); }
  function videoType(){ var t = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']; for(var i = 0; i < t.length; i++){ if(window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t[i])) return t[i]; } return ''; }
  function vext(b){ return /mp4/.test(b.type) ? 'mp4' : /quicktime/.test(b.type) ? 'mov' : /webm/.test(b.type) ? 'webm' : 'mp4'; }

  /* ---------- the Studio page ---------- */
  function Studio(go){
    if(!unlocked()) return Login(go);
    var state = { image: null, video: null }, stream = null, rec = null, timer = null, chunks = [];
    var c = cfg();
    var title = h('input', { type: 'text', id: 'st-title', maxlength: '90', placeholder: 'Title of today\'s devotion', 'aria-label': 'Title' }),
      ref = h('input', { type: 'text', id: 'st-ref', maxlength: '60', placeholder: 'Scripture (optional), e.g. John 3:16', 'aria-label': 'Scripture' }),
      body = h('textarea', { id: 'st-body', rows: '8', placeholder: 'Type your devotion here', 'aria-label': 'Devotion text' }),
      hc = h('input', { type: 'checkbox', id: 'st-hc' }), status = h('p', { class: 'note', id: 'st-status', role: 'status' }), mediaNote = h('p', { class: 'note', id: 'st-media' }, 'No picture or video added.');
    var preview = h('div', { id: 'st-preview', style: 'margin-top:8px' }), live = h('video', { id: 'st-live', muted: true, playsinline: true, style: 'width:100%;border-radius:12px;background:#000;display:none' });
    function showMedia(){ preview.innerHTML = ''; var n = []; if(state.image){ preview.appendChild(h('img', { src: URL.createObjectURL(state.image), alt: 'Picture to post', style: 'width:100%;border-radius:12px;margin-top:6px' })); n.push('Picture ' + Math.round(state.image.size / 1024) + ' KB'); }
      if(state.video){ preview.appendChild(h('video', { src: URL.createObjectURL(state.video), controls: true, playsinline: true, style: 'width:100%;border-radius:12px;margin-top:6px;background:#000' })); n.push('Video ' + (state.video.size / 1048576).toFixed(1) + ' MB'); }
      mediaNote.textContent = n.length ? n.join(' · ') : 'No picture or video added.'; if(window.__stReady) window.__stReady(); }
    var imgIn = h('input', { type: 'file', accept: 'image/*', id: 'st-img', style: 'display:none', onchange: function(){ var f = this.files[0]; this.value = ''; if(!f) return; shrinkImage(f).then(function(b){ state.image = b; showMedia(); }, function(e){ toast(e.message); }); } });
    var vidIn = h('input', { type: 'file', accept: 'video/*', id: 'st-vid', style: 'display:none', onchange: function(){ var f = this.files[0]; this.value = ''; if(!f) return; if(f.size > MAX_VIDEO){ toast('That video is ' + (f.size / 1048576).toFixed(0) + ' MB. The limit is 30 MB. Record a shorter one.'); return; } state.video = f; showMedia(); } });
    var facing = 'user', camOn = false, camBox = h('div', { id: 'st-cam', class: 'row', style: 'display:none;margin-top:8px;gap:8px;flex-wrap:wrap;justify-content:flex-start' });
    var openBtn = h('button', { class: 'btn ghost', type: 'button', id: 'st-cam-open', onclick: function(){ camOn ? closeCam() : openCam(); } }, '📷 Open camera'),
      snapBtn = h('button', { class: 'btn', type: 'button', id: 'st-snap', onclick: function(){ snap(); } }, 'Take picture'),
      recBtn = h('button', { class: 'btn', type: 'button', id: 'st-rec', onclick: function(){ rec && rec.state === 'recording' ? stopRec() : startRec(); } }, '🎥 Record video'),
      flipBtn = h('button', { class: 'btn ghost', type: 'button', id: 'st-flip', onclick: function(){ if(rec && rec.state === 'recording'){ toast('Stop the recording first'); return; } facing = facing === 'user' ? 'environment' : 'user'; openCam(); } }, 'Switch camera');
    camBox.append(snapBtn, recBtn, flipBtn);
    function setRecLabel(s){ recBtn.textContent = s ? '⏹ Stop (' + s + 's)' : '🎥 Record video'; }
    function stopStream(){ if(stream){ stream.getTracks().forEach(function(t){ t.stop(); }); stream = null; } live.srcObject = null; clearInterval(timer); setRecLabel(0); }
    function closeCam(){ if(rec && rec.state === 'recording'){ try { rec.onstop = null; rec.stop(); } catch(e) {} } stopStream(); camOn = false; live.style.display = 'none'; camBox.style.display = 'none'; openBtn.textContent = '📷 Open camera'; }
    function openCam(){ if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ toast('The camera is not available here. Use Add picture or Upload video.'); return; }
      stopStream(); var vc = { facingMode: facing, width: { ideal: 1280 }, height: { ideal: 720 } };
      navigator.mediaDevices.getUserMedia({ video: vc, audio: true }).catch(function(){ toast('Microphone not allowed, so videos will have no sound.'); return navigator.mediaDevices.getUserMedia({ video: vc, audio: false }); }).then(function(s){
        stream = s; camOn = true; live.srcObject = s; live.style.display = 'block'; camBox.style.display = 'block'; live.style.transform = facing === 'user' ? 'scaleX(-1)' : 'none'; openBtn.textContent = '✕ Close camera'; live.play().catch(function(){});
      }, function(){ toast('Camera was not allowed. Allow it in the browser or phone settings, or use Add picture or Upload video.'); }); }
    function snap(){ if(!stream || !live.videoWidth){ toast('Open the camera first'); return; } var cv = document.createElement('canvas'), s = Math.min(1, 1280 / Math.max(live.videoWidth, live.videoHeight)); cv.width = Math.round(live.videoWidth * s); cv.height = Math.round(live.videoHeight * s); cv.getContext('2d').drawImage(live, 0, 0, cv.width, cv.height);
      cv.toBlob(function(b){ if(!b){ toast('Could not take the picture'); return; } state.image = b; showMedia(); toast('Picture taken'); }, 'image/jpeg', 0.85); }
    function startRec(){ if(!stream){ toast('Open the camera first'); return; } if(!window.MediaRecorder){ toast('Recording is not available here. Use Upload video instead.'); return; }
      chunks = []; var type = videoType(), opt = { videoBitsPerSecond: 1000000, audioBitsPerSecond: 64000 }; if(type) opt.mimeType = type; rec = new MediaRecorder(stream, opt);
      rec.ondataavailable = function(e){ if(e.data && e.data.size) chunks.push(e.data); };
      rec.onstop = function(){ clearInterval(timer); setRecLabel(0); setTimeout(refreshReady, 0); var b = new Blob(chunks, { type: rec.mimeType || type || 'video/webm' }); if(b.size > MAX_VIDEO){ toast('That recording is too big (limit 30 MB). Record a shorter one.'); return; } state.video = b; showMedia(); toast('Video recorded'); };
      rec.start(1000); refreshReady(); var left = MAX_SECONDS; setRecLabel(left); timer = setInterval(function(){ if(!document.body.contains(live)){ closeCam(); return; } left--; setRecLabel(left); if(left <= 0) stopRec(); }, 1000); }
    function stopRec(){ try { if(rec && rec.state === 'recording') rec.stop(); } catch(e) { closeCam(); } }

    var postBtn = h('button', { class: 'btn block', type: 'button', id: 'st-post', onclick: function(){
      var cf = persist(); if(!cf.token){ toast('The token is missing. Paste it in Publishing setup and tap Save and check.'); return; } if(!cf.repo){ toast('The repository is missing. Add it in Publishing setup.'); return; }
      var t = title.value.trim(), tx = body.value.trim(); if(!t){ toast('Add a title'); return; } if(!tx && !state.image && !state.video){ toast('Add some text, a picture or a video'); return; }
      if(rec && rec.state === 'recording'){ toast('Stop the recording first'); return; }
      var p = { id: newId(), title: t, ref: ref.value.trim(), body: tx, at: new Date().toISOString(), homecell: hc.checked }, files = [];
      if(state.image){ p.image = 'posts/' + p.id + '/picture.jpg'; files.push({ name: 'picture.jpg', label: 'picture', blob: state.image }); }
      if(state.video){ var vn = 'video.' + vext(state.video); p.video = 'posts/' + p.id + '/' + vn; files.push({ name: vn, label: 'video', blob: state.video }); }
      postBtn.disabled = true; refreshReady(); var step = function(m){ status.textContent = m; };
      publish(p, files, step).then(function(){ step('Posted. It can take a minute or two to show on every phone.'); toast('Posted'); title.value = ''; ref.value = ''; body.value = ''; hc.checked = false; state.image = state.video = null; showMedia(); postBtn.disabled = false; drawList(); },
        function(e){ postBtn.disabled = false; refreshReady(); step((e.status === 401 ? 'GitHub says the token is not valid (401). It may have been copied wrong or has expired. Make a new one. ' : e.status === 403 ? 'GitHub refused (403). The token needs Contents: Read and write for this repository, and it must be made in the account that owns the repository. ' : e.status === 404 ? 'GitHub could not find the repository with this token (404). The repository name may be wrong, or the token was not made for it. ' : 'Could not post. ') + (e.message ? 'GitHub says: ' + e.message : '')); }); } }, 'Post to Devotions');

    /* the Post button turns green when everything needed is in place */
    function refreshReady(){ var k = cfg(), recording = rec && rec.state === 'recording', ok = title.value.trim() && (body.value.trim() || state.image || state.video) && k.token && k.repo && !recording && !postBtn.disabled;
      postBtn.classList.toggle('ready', !!ok); postBtn.textContent = ok ? '✓ Ready, Post to Devotions' : 'Post to Devotions'; }
    ['input', 'change'].forEach(function(ev){ title.addEventListener(ev, refreshReady); body.addEventListener(ev, refreshReady); });
    var list = h('div', { class: 'stack', id: 'st-list' });
    function drawList(){ list.innerHTML = ''; list.appendChild(h('p', { class: 'note' }, 'Loading your posts...'));
      fetchFeed().then(function(all){ list.innerHTML = ''; if(!all.length){ list.appendChild(h('p', { class: 'note' }, 'No posts yet.')); return; }
        all.forEach(function(p){ var hcb = h('button', { class: 'btn ghost sm', type: 'button', 'data-act': 'homecell', onclick: function(){ var cf = cfg(); if(!cf.token){ toast('Set up publishing first'); return; } var on = !p.homecell; hcb.disabled = true; setHomecell(p, on).then(function(){ p.homecell = on; toast(on ? 'Pushed to the Homecell' : 'Taken off the Homecell'); drawList(); }, function(e){ hcb.disabled = false; toast('Could not change it: ' + e.message); }); } }, p.homecell ? '✓ In Homecell (tap to remove)' : 'Push to Homecell'),
          invB = h('button', { class: 'btn ghost sm', type: 'button', 'data-act': 'invite', onclick: function(){ E.share('New from Ashelz: ' + p.title + '\nOpen the Ashelz Bible App, Devotions page, to read and watch it.'); } }, 'Invite the group'),
          delB = h('button', { class: 'btn ghost sm', type: 'button', 'data-act': 'delete', onclick: function(){ if(!cfg().token){ toast('Set up publishing first'); return; } if(!confirm('Delete this post for everyone?')) return; delB.disabled = true; removePost(p).then(function(){ toast('Deleted'); drawList(); }, function(e){ delB.disabled = false; toast('Could not delete: ' + e.message); }); } }, 'Delete');
          list.appendChild(PostCard(p, h('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap;justify-content:flex-start;margin-top:8px' }, hcb, invB, delB))); }); }); }

    var cu = h('input', { type: 'email', id: 'cp-user', placeholder: 'Developer email', autocomplete: 'username', 'aria-label': 'Developer email' }), cp = h('input', { type: 'password', id: 'cp-old', placeholder: 'Current password', autocomplete: 'current-password', 'aria-label': 'Current password' }), np = h('input', { type: 'password', id: 'cp-new', placeholder: 'New password (at least 10 characters)', autocomplete: 'new-password', 'aria-label': 'New password' }), np2 = h('input', { type: 'password', id: 'cp-new2', placeholder: 'Type the new password again', autocomplete: 'new-password', 'aria-label': 'New password again' }), cpm = h('p', { class: 'note', id: 'cp-msg', role: 'status' });
    var pwCard = h('div', { class: 'card' }, h('div', { class: 'ch' }, h('span', { class: 'ic' }, E.icon('shield')), 'Change password'), h('p', { class: 'note' }, 'The new password is saved on this device only, as a salted hash. On a different phone or computer the older password still opens the Studio screen until the app files are updated. Publishing always needs the GitHub token.'), cu, cp, np, np2,
      h('button', { class: 'btn', type: 'button', id: 'cp-go', style: 'margin-top:8px', onclick: function(){ if(np.value.length < 10){ cpm.textContent = 'Use at least 10 characters.'; return; } if(np.value !== np2.value){ cpm.textContent = 'The two new passwords are not the same.'; return; } if(np.value === cp.value){ cpm.textContent = 'Choose a password that is different from the current one.'; return; }
        derive(cu.value, cp.value).then(function(d){ if(d !== DEVC().hash){ cpm.textContent = 'The email or current password is not right.'; return; }
          var salt = crypto.getRandomValues(new Uint8Array(16)), nc = { salt: hex(salt), hash: '', iter: 250000 };
          return derive(cu.value, np.value, nc).then(function(nh){ nc.hash = nh; save(CREDKEY, nc); try { sessionStorage.setItem(SESS, nh.slice(0, 16)); } catch(e) {} cu.value = cp.value = np.value = np2.value = ''; cpm.textContent = 'Password changed on this device.'; toast('Password changed'); }); }, function(){ cpm.textContent = 'Could not change it on this device.'; }); } }, 'Change password'), cpm);
    var repo = h('input', { type: 'text', id: 'st-repo', value: c.repo, placeholder: 'owner/repository, e.g. mrandrecloete-hub/ashelz-bible-app', 'aria-label': 'Repository', autocomplete: 'off' }),
      br = h('input', { type: 'text', id: 'st-branch', value: c.branch, placeholder: 'main', 'aria-label': 'Branch', autocomplete: 'off' }),
      tok = h('input', { type: 'text', id: 'st-token', name: 'gh-fine-grained-token', value: c.token, placeholder: 'Paste the token here (kept on this device only)', 'aria-label': 'Token', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', style: '-webkit-text-security:disc;text-security:disc' });
    var badge = h('p', { class: 'note', id: 'st-badge', role: 'status' });
    function showBadge(){ var k = cfg(); badge.textContent = k.token && k.repo ? 'Publishing is set up for ' + k.repo + ' (' + k.branch + '). Token saved on this device: ' + k.token.slice(0, 11) + '... ' + k.token.length + ' characters' + (/^(github_pat_|ghp_)/.test(k.token) && k.token.length >= 40 ? '.' : '. This does not look like a full GitHub token. Copy it again with the copy button.') : 'Publishing is not set up yet: ' + (!k.repo ? 'repository missing' : 'token missing') + '. Fill in Publishing setup at the bottom and tap Save and check.'; }
    function persist(){ setTimeout(function(){ if(window.__stReady) window.__stReady(); }, 0); var before = load(KEY, {}).token || '', r = repo.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, ''), t = tok.value.replace(/^\s*Bearer\s+/i, '').replace(/[^A-Za-z0-9_]/g, ''), o = load(KEY, {}); save(KEY, { repo: r || o.repo || '', branch: br.value.trim() || o.branch || 'main', token: t || o.token || '' }); showBadge(); var kk = cfg(); kk.replaced = !!t && t !== before; kk.fresh = !!t; return kk; }
    var setup = h('div', { class: 'card' }, h('div', { class: 'ch' }, h('span', { class: 'ic' }, E.icon('gear')), 'Publishing setup'),
      h('p', { class: 'note' }, 'Posts are saved as files in the app\'s GitHub repository. In GitHub: Settings, Developer settings, Fine grained tokens. Choose only this repository and give it Contents: Read and write. Paste it here once. It stays on this device only and is never put in the app files.'), repo, br, tok,
      h('div', { class: 'row', style: 'gap:8px;margin-top:8px;flex-wrap:wrap;justify-content:flex-start' }, h('button', { class: 'btn', type: 'button', id: 'st-save', onclick: function(){ var k = persist(); if(!k.token){ toast('The token box is empty. Paste the token first.'); return; } if(!/^[\w.-]+\/[\w.-]+$/.test(k.repo)){ toast('Repository should look like owner/repository'); return; } toast((k.fresh ? (k.replaced ? 'New token saved' : 'Same token as before') : 'No token pasted, keeping the old one') + ': ' + k.token.slice(0, 15) + '...' + k.token.slice(-4) + ' (' + k.token.length + ' characters). Checking...'); fetch('https://api.github.com/repos/' + k.repo, { headers: { 'Authorization': 'Bearer ' + k.token, 'Accept': 'application/vnd.github+json' } }).then(function(r){ if(!r.ok){ toast(r.status === 401 ? 'GitHub does not recognise this token (401). It ends with ' + k.token.slice(-4) + '. Compare that with the end of the token you copied from GitHub.' : r.status === 404 ? 'GitHub cannot find ' + k.repo + ' with this token (404). The token must be made in the account that owns the repository, with that repository selected.' : 'GitHub answered ' + r.status); return; } return r.json().then(function(j){ toast(j.permissions && j.permissions.push === false ? 'Connected, but this token can only read. Set Contents to Read and write.' : 'Connected to ' + k.repo + '. Ready to post.'); }); }, function(){ toast('Saved, but could not reach GitHub to check'); }); } }, 'Save and check'),
        h('button', { class: 'btn ghost', type: 'button', id: 'st-forget', onclick: function(){ save(KEY, {}); tok.value = ''; showBadge(); toast('Token removed from this device'); } }, 'Remove token from this device')));
    window.__stReady = refreshReady; drawList(); showBadge(); refreshReady();
    var pg = E.page('Creator Studio', 'play', go, h('div', { class: 'stack narrow' },
      h('div', { class: 'row' }, h('p', { class: 'note' }, 'Write, record or upload your own devotion and post it straight to the Devotions page. Anyone can read, watch and download it.'), h('button', { class: 'btn ghost sm', type: 'button', id: 'dv-out', onclick: function(){ lockNow(); toast('Signed out'); go('studio'); } }, 'Sign out')),
      h('div', { class: 'card' }, h('div', { class: 'ch' }, h('span', { class: 'ic' }, E.icon('journal')), 'New post'), title, ref, body,
        h('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;justify-content:flex-start;margin-top:8px' }, openBtn, h('button', { class: 'btn ghost', type: 'button', id: 'st-pick-vid', onclick: function(){ vidIn.click(); } }, 'Upload video'), h('button', { class: 'btn ghost', type: 'button', id: 'st-pick-img', onclick: function(){ imgIn.click(); } }, 'Add picture'), imgIn, vidIn),
        h('div', { class: 'camwrap' }, live, camBox), mediaNote, preview,
        h('label', { class: 'row', style: 'justify-content:flex-start;gap:8px;margin:10px 0', for: 'st-hc' }, hc, h('span', {}, 'Also push it to the Online Homecell')),
        postBtn, badge, status),
      h('h2', { style: 'font-size:1.1rem;margin:4px 0 0' }, 'Your posts'), list, pwCard, setup));
    return pg;
  }
  return { Studio: Studio, Block: Block, fetchFeed: fetchFeed, PostCard: PostCard };
};
