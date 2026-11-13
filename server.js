const path = require('path');
const express = require('express');
const session = require('cookie-session');

const { loadSession } = require('./middleware/auth');
const { UPLOADS_DIR, IS_SERVERLESS } = require('./utils/paths');

// Express 4 doesn't forward rejected promises from async handlers to the
// error handler (the request would just hang). Route every handler's
// returned promise into next(err) - same behaviour Express 5 has built in.
const Layer = require('express/lib/router/layer');
Layer.prototype.handle_request = function handle(req, res, next) {
  const fn = this.handle;
  if (fn.length > 3) return next();
  try {
    const out = fn(req, res, next);
    if (out && typeof out.catch === 'function') out.catch(next);
  } catch (err) {
    next(err);
  }
};

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET && (IS_SERVERLESS || process.env.NODE_ENV === 'production')) {
  console.warn('WARNING: SESSION_SECRET is not set - login cookies are signed with a public default. Set it in the host environment.');
}

// Behind Netlify / a reverse proxy: trust X-Forwarded-* for req.ip.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Registered explicitly (rather than letting Express require('ejs') by
// name at render time) so serverless bundlers see the dependency.
app.engine('ejs', require('ejs').__express);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'SAMEORIGIN');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(self), camera=(self), microphone=()');
  next();
});

// 1 MB so a signed-for job (signature image) fits in one form post.
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '200kb' }));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  // Signed-cookie sessions (only memberId is stored) rather than a
  // server-side store, so a login survives across serverless instances.
  session({
    name: 'hvac.sid',
    secret: process.env.SESSION_SECRET || 'hvac-training-dev-secret',
    maxAge: 1000 * 60 * 60 * 12,
    sameSite: 'lax',
    httpOnly: true,
    // Opt-in: only safe once the host is confirmed to pass
    // X-Forwarded-Proto: https through to the app.
    secure: process.env.COOKIE_SECURE === '1',
  })
);

app.use(loadSession);

// One-shot ?notice= / ?error= messages for every page.
app.use((req, res, next) => {
  res.locals.notice = typeof req.query.notice === 'string' ? req.query.notice.slice(0, 500) : null;
  res.locals.error = typeof req.query.error === 'string' ? req.query.error.slice(0, 500) : null;
  next();
});

// Signed-in users with a temporary password must set their own first.
app.use((req, res, next) => {
  if (req.member && req.member.must_change_password && !/^\/(account|logout|css|js|icons|login|manifest\.webmanifest|sw\.js|offline\.html)/.test(req.path)) {
    return res.redirect('/account?error=' + encodeURIComponent('Please choose a new password to continue.'));
  }
  next();
});

app.use('/', require('./routes/pwa'));
app.use('/', require('./routes/public'));
app.use('/api', require('./routes/api'));
app.use('/', require('./routes/auth'));
app.use('/', require('./routes/portal'));
app.use('/events', require('./routes/events'));
app.use('/', require('./routes/training'));
app.use('/member-directory', require('./routes/memberDirectory'));
app.use('/notifications', require('./routes/notifications'));
app.use('/forums', require('./routes/forums'));
app.use('/documents', require('./routes/documents'));

// HVAC business system modules
app.use('/employee', require('./routes/employee'));
app.use('/service', require('./routes/service'));
app.use('/customers', require('./routes/customers'));
app.use('/requests', require('./routes/requests'));
app.use('/', require('./routes/jobs'));
app.use('/', require('./routes/inventory'));
app.use('/invoices', require('./routes/billing'));
app.use('/accounting', require('./routes/accounting'));
app.use('/manage', require('./routes/manage'));
app.use('/admin', require('./routes/admin'));
app.use('/account', require('./routes/account'));
app.use('/estimates', require('./routes/estimates'));
app.use('/', require('./routes/purchasing'));
app.use('/expenses', require('./routes/expenses'));
app.use('/agreements', require('./routes/agreements'));
app.use('/payroll', require('./routes/payroll'));
app.use('/', require('./routes/team'));
app.use('/', require('./routes/customerPortal'));
app.use('/', require('./routes/files'));
app.use('/', require('./routes/trainingCenter'));
app.use('/', require('./routes/meetings'));
app.use('/', require('./routes/teamChecklists'));

app.use('/website', require('./routes/website'));
// Public website: "/" (the published home page, otherwise the staff
// login) and published pages by address. Last, so app URLs always win.
app.use('/', require('./routes/site'));

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.use((err, req, res, next) => {
  void next;
  console.error(err);
  if (err.type === 'entity.too.large' || err.code === 'LIMIT_FILE_SIZE') return res.status(413).send('That upload is too large.');
  // Never echo internal error details (SQL, stack) to the browser.
  res.status(500).send('Something went wrong. The error has been logged.');
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`HVAC Business Portal listening on http://localhost:${PORT}`));
}

module.exports = app;
