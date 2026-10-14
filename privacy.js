/* renders the privacy policy or the delete my data page from legal.js */
(function(){ var L = window.LEGAL, del = /[?&]delete\b/.test(location.search), list = del ? L.del : L.privacy, root = document.getElementById('c');
  document.getElementById('t').textContent = (del ? 'Delete my data' : 'Privacy Policy') + ', ' + L.C.app; document.title = (del ? 'Delete my data' : 'Privacy Policy') + ', ' + L.C.app;
  list.forEach(function(s){ var h2 = document.createElement('h2'); h2.textContent = s[0]; root.appendChild(h2); s[1].forEach(function(t){ var p = document.createElement('p'); p.textContent = t; root.appendChild(p); }); });
})();
