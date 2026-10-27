"""Assembles web/dist-demo into one self-contained HTML page (inline JS/CSS, data-URI assets) for hosting as a static artifact."""
import base64, sys
d = 'web/dist-demo/'
def uri(path, mime): return f'data:{mime};base64,' + base64.b64encode(open(path, 'rb').read()).decode()
css = open(d + 'demo.css').read()
css = css.replace('url(/wallpaper-light.svg)', 'url(' + uri('web/public/wallpaper-light.svg', 'image/svg+xml') + ')').replace('url(/wallpaper-dark.svg)', 'url(' + uri('web/public/wallpaper-dark.svg', 'image/svg+xml') + ')')
js = open(d + 'demo.js').read().replace('`/logo.png`', '`' + uri('web/public/icons/logo-192.png', 'image/png') + '`').replace('</script', '<\\/script')
html = f'''<meta charset="utf-8">
<title>Wazzupp Demo</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap">
<style>{css}</style>
<div id="root"></div>
<script type="module">{js}</script>'''
open(sys.argv[1], 'w').write(html)
print(len(html) // 1024, 'KB')
