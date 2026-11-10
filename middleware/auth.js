// Session-based auth enforcement - see routes/auth.js for how
// req.session.memberId gets set. loadSession runs on every request (so
// public pages can still greet a signed-in visitor) and resolves the
// member's permissions; requireAuth / requirePermission gate routes.
const { findById } = require('../utils/auth');
const { unreadCount } = require('../utils/notifications');
const permissions = require('../utils/permissions');
const fmt = require('../utils/format');

const DENY = () => false;

async function loadSession(req, res, next) {
  try {
    res.locals.member = null;
    res.locals.unreadNotifications = 0;
    res.locals.currentPath = req.path;
    res.locals.fmt = fmt;
    res.locals.can = DENY;
    res.locals.homeHref = '/portal';
    req.can = DENY;
    const id = req.session && req.session.memberId;
    if (!id) return next();
    const member = await findById(id);
    if (!member || !member.active) {
      req.session.memberId = null;
      return next();
    }
    const can = permissions.makeChecker(await permissions.permissionsForRole(member.role));
    req.member = member;
    req.can = can;
    res.locals.member = member;
    res.locals.can = can;
    res.locals.homeHref = permissions.homeFor(can);
    res.locals.unreadNotifications = await unreadCount(member.id);
    next();
  } catch (err) {
    next(err);
  }
}

function requireAuth(req, res, next) {
  if (!req.member) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  next();
}

function forbidden(res) {
  return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have access to this page." });
}

// Passes when the member holds ANY of the listed permissions.
function requirePermission(...keys) {
  return function (req, res, next) {
    if (!req.member) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!req.can(...keys)) return forbidden(res);
    next();
  };
}

// Backwards-compatible wrapper for the original three-role checks:
// 'instructor' meant "can manage training content", 'admin' meant
// "can manage accounts".
const LEGACY = { student: ['training.view'], instructor: ['training.manage'], admin: ['users.manage'] };
function requireRole(minRole) {
  return requirePermission(...(LEGACY[minRole] || ['system.admin']));
}

module.exports = { loadSession, requireAuth, requirePermission, requireRole, forbidden };
