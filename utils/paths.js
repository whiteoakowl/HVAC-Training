// Where runtime-writable state lives. Locally that's the repo itself
// (data/ and uploads/). On Netlify the app runs inside a serverless
// function whose deploy bundle is read-only, so everything writable goes
// under /tmp instead - which is per-instance and wiped on cold start, so
// a Netlify deploy behaves as a self-resetting demo (see README).
const path = require('path');
const fs = require('fs');

const IS_SERVERLESS = Boolean(process.env.NETLIFY || process.env.AWS_LAMBDA_FUNCTION_NAME);
const ROOT = IS_SERVERLESS ? '/tmp/hvac-training' : path.join(__dirname, '..');

const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'data');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(ROOT, 'uploads');

for (const dir of [DATA_DIR, path.join(UPLOADS_DIR, 'documents'), path.join(UPLOADS_DIR, 'photos')]) {
  fs.mkdirSync(dir, { recursive: true });
}

module.exports = { IS_SERVERLESS, DATA_DIR, UPLOADS_DIR };
