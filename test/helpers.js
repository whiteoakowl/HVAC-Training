// Test harness: boots the real app against a throwaway database and
// drives it over HTTP with a tiny cookie-aware client.
//   - SQLite by default (fresh temp DATA_DIR per test file)
//   - Postgres when TEST_DATABASE_URL is set (the database must be empty)
const fs = require('fs');
const os = require('os');
const path = require('path');

function setupEnv() {
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
  } else {
    delete process.env.DATABASE_URL;
  }
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'hvac-test-'));
  process.env.UPLOADS_DIR = path.join(process.env.DATA_DIR, 'uploads');
  process.env.SESSION_SECRET = 'test-secret';
  delete process.env.RESEND_API_KEY;
  delete process.env.TWILIO_ACCOUNT_SID;
}

async function start({ demo = true } = {}) {
  setupEnv();
  const db = require('../db');
  await db.ready;
  await require('../db/seed')({ demo });
  const app = require('../server');
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db,
    base,
    async stop() {
      await new Promise((r) => server.close(r));
      if (db.close) await db.close();
    },
  };
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = {};
  }

  cookieHeader() {
    return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(res) {
    const set = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    for (const c of set) {
      const [pair] = c.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i);
      const v = pair.slice(i + 1);
      if (v === '' || /expires=Thu, 01 Jan 1970/i.test(c)) delete this.cookies[k];
      else this.cookies[k] = v;
    }
  }

  async request(method, url, { form = null, json = null, headers = {}, follow = true, body = null } = {}) {
    let target = url.startsWith('http') ? url : this.base + url;
    const h = { cookie: this.cookieHeader(), ...headers };
    let payload = body;
    if (form) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
        else if (v !== undefined && v !== null) p.append(k, String(v));
      }
      payload = p.toString();
      h['content-type'] = 'application/x-www-form-urlencoded';
    }
    if (json) {
      payload = JSON.stringify(json);
      h['content-type'] = 'application/json';
    }
    let res = await fetch(target, { method, headers: h, body: payload, redirect: 'manual' });
    this.store(res);
    let hops = 0;
    while (follow && res.status >= 300 && res.status < 400 && hops++ < 5) {
      target = new URL(res.headers.get('location'), target).toString();
      res = await fetch(target, { headers: { cookie: this.cookieHeader() }, redirect: 'manual' });
      this.store(res);
    }
    const text = await res.text();
    return { status: res.status, text, url: target, headers: res.headers, location: res.headers.get('location') };
  }

  get(url, opts) {
    return this.request('GET', url, opts);
  }

  post(url, form, opts = {}) {
    return this.request('POST', url, { ...opts, form });
  }

  async login(email, password = 'password123') {
    const r = await this.post('/login', { email, password });
    if (!this.cookies['hvac.sid']) throw new Error(`login failed for ${email}: ${r.status} ${r.url}`);
    return r;
  }
}

// Pulls the flash message out of a redirect URL / page.
function flashOf(r) {
  const u = new URL(r.url);
  return u.searchParams.get('error') || u.searchParams.get('notice');
}

function idFrom(url, prefix) {
  const m = new URL(url).pathname.match(new RegExp(`^${prefix}/(\\d+)`));
  return m ? parseInt(m[1], 10) : null;
}

module.exports = { start, Client, flashOf, idFrom };
