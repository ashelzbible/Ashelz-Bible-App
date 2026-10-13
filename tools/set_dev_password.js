/* Makes the built in developer sign in hash for studio.js. Run:  node tools/set_dev_password.js "email" "new password"
   Paste the printed salt and hash into DEV0 in studio.js. The password itself is never written to any file. */
var c = require('crypto'), u = (process.argv[2] || '').trim().toLowerCase(), p = process.argv[3] || '';
if(!u || p.length < 10){ console.log('Usage: node tools/set_dev_password.js "email" "password of at least 10 characters"'); process.exit(1); }
var salt = c.randomBytes(16), h = c.pbkdf2Sync(u + '\n' + p, salt, 250000, 32, 'sha256');
console.log("var DEV0 = { salt: '" + salt.toString('hex') + "', hash: '" + h.toString('hex') + "', iter: 250000 }");
