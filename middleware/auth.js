// Session-based auth enforcement - see routes/auth.js for how
// req.session.memberId gets set. loadSession runs on every request (so
// public pages can still greet a signed-in visitor); requireAuth/
// requireRole gate the routes that actually need it.
const { findById } = require('../utils/auth');
const { unreadCount } = require('../utils/notifications');

async function loadSession(req, res, next) {
  res.locals.member = null;
  res.locals.unreadNotifications = 0;
  res.locals.currentPath = req.path;
  const id = req.session && req.session.memberId;
  if (!id) return next();
  const member = await findById(id);
  if (!member || !member.active) {
    req.session.memberId = null;
    return next();
  }
  req.member = member;
  res.locals.member = member;
  res.locals.unreadNotifications = await unreadCount(member.id);
  next();
}

function requireAuth(req, res, next) {
  if (!req.member) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

// requireRole('instructor') means "instructor or higher" - admin can
// always do what an instructor can, and an instructor can always do what
// a student can, since a plain hierarchical scale is all three roles
// here need (unlike the reference app's independent role/permission
// grid, built for members holding several unrelated portals at once).
const RANK = { student: 1, instructor: 2, admin: 3 };
function requireRole(minRole) {
  return function (req, res, next) {
    if (!req.member) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (RANK[req.member.role] < RANK[minRole]) {
      return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this page." });
    }
    next();
  };
}

module.exports = { loadSession, requireAuth, requireRole };
