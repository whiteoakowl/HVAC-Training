const path = require('path');
const express = require('express');
const session = require('cookie-session');

const { loadSession } = require('./middleware/auth');
const { UPLOADS_DIR } = require('./utils/paths');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  // Signed-cookie sessions (only memberId is stored) rather than a
  // server-side store, so a login survives across serverless instances.
  session({
    name: 'hvac.sid',
    secret: process.env.SESSION_SECRET || 'hvac-training-dev-secret',
    maxAge: 1000 * 60 * 60 * 24 * 14,
    sameSite: 'lax',
    httpOnly: true,
  })
);

app.use(loadSession);

app.use('/', require('./routes/auth'));
app.use('/', require('./routes/portal'));
app.use('/events', require('./routes/events'));
app.use('/', require('./routes/training'));
app.use('/member-directory', require('./routes/memberDirectory'));
app.use('/notifications', require('./routes/notifications'));
app.use('/forums', require('./routes/forums'));
app.use('/documents', require('./routes/documents'));

app.get('/', (req, res) => res.redirect(req.member ? '/portal' : '/login'));

app.use((req, res) => res.status(404).render('404', { title: 'Not Found' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).send('Something went wrong: ' + err.message);
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`HVAC Training Portal listening on http://localhost:${PORT}`));
}

module.exports = app;
