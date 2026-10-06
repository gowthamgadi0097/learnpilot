// Runs automatically before `npm start`. Creates .env on first run so the app works out of the box.
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..'), env = path.join(root, '.env');
if (fs.existsSync(env) || process.env.JWT_SECRET) process.exit(0);   // already configured (file or hosting dashboard)
const text = fs.readFileSync(path.join(root, '.env.example'), 'utf8')
  .replace('change-me-to-a-long-random-string', crypto.randomBytes(32).toString('hex'));
fs.writeFileSync(env, text);
console.log(`
Created .env with a random JWT_SECRET.
  Teacher login : teacher@college.edu / ChangeMe123   (edit .env, delete learnpilot.db, restart to change it)
  AI features   : paste your ANTHROPIC_API_KEY into .env (console.anthropic.com), then restart
`);
