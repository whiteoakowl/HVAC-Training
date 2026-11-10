// Small route helpers shared by the business modules.

// Redirect with a one-shot ?notice= / ?error= message (the convention
// the original routes already use).
function flash(res, url, type, message) {
  // The query string must come before any #fragment.
  const [path, hash] = String(url).split('#');
  const sep = path.includes('?') ? '&' : '?';
  return res.redirect(`${path}${sep}${type}=${encodeURIComponent(message)}${hash ? '#' + hash : ''}`);
}

// Validation errors thrown by utils/* are plain Errors with a message
// meant for the user. Database/driver errors carry a `code` and are
// logged but shown generically, so internals never reach the browser.
function userMessage(err) {
  if (err && err.code) {
    console.error(err);
    return 'Something went wrong saving that. Nothing was changed.';
  }
  return (err && err.message) || 'Something went wrong.';
}

// Wraps a POST handler: on a thrown error, redirect to backUrl(req) with
// the message instead of a 500 page.
function action(fn, backUrl) {
  return async (req, res, next) => {
    try {
      await fn(req, res, next);
    } catch (err) {
      let url = typeof backUrl === 'function' ? backUrl(req) : backUrl;
      if (!url) {
        // Same-site path only - never redirect to another host's Referer.
        try {
          const ref = new URL(req.get('Referer'));
          url = ref.pathname + ref.search;
        } catch (e) {
          url = '/home';
        }
      }
      flash(res, String(url).replace(/[?&](notice|error)=[^&]*/g, ''), 'error', userMessage(err));
    }
  };
}

function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}

function asArray(v) {
  if (v === undefined || v === null || v === '') return [];
  return Array.isArray(v) ? v : [v];
}

module.exports = { flash, userMessage, action, int, asArray };
