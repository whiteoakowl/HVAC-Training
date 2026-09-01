const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const forums = require('../utils/forums');
const notifications = require('../utils/notifications');

router.use(requireAuth);

function canModerate(req) {
  return req.member.role === 'instructor' || req.member.role === 'admin';
}

async function loadCategory(req, res, next) {
  const category = await forums.getCategory(req.params.categoryId);
  if (!category) return res.status(404).render('404', { title: 'Not Found' });
  req.category = category;
  next();
}

async function loadThread(req, res, next) {
  const thread = await forums.getThread(req.params.threadId);
  if (!thread) return res.status(404).render('404', { title: 'Not Found' });
  req.thread = thread;
  req.category = await forums.getCategory(thread.category_id);
  next();
}

router.get('/', async (req, res) => {
  res.render('forums-list', { title: 'Chat', categories: await forums.listCategories() });
});

router.post('/categories', requireRole('admin'), async (req, res) => {
  await forums.createCategory((req.body.name || '').trim(), (req.body.description || '').trim());
  res.redirect('/forums');
});

router.get('/:categoryId', loadCategory, async (req, res) => {
  res.render('forums-category', { title: req.category.name, category: req.category, threads: await forums.listThreads(req.category.id), canModerate: canModerate(req) });
});

router.get('/:categoryId/new', loadCategory, (req, res) => {
  if (req.category.is_locked && !canModerate(req)) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'This chat is locked - only moderators can start new threads.' });
  }
  res.render('forums-new-thread', { title: `New Thread - ${req.category.name}`, category: req.category, error: req.query.error || null });
});

router.post('/:categoryId/threads', loadCategory, async (req, res) => {
  if (req.category.is_locked && !canModerate(req)) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'This chat is locked.' });
  }
  const title = (req.body.title || '').trim();
  const body = (req.body.body || '').trim();
  if (!title || !body) return res.redirect(`/forums/${req.category.id}/new?error=` + encodeURIComponent('Title and a message are both required.'));
  const threadId = await forums.createThread(req.category.id, title, body, req.member.id);
  res.redirect(`/forums/threads/${threadId}`);
});

router.get('/threads/:threadId', loadThread, async (req, res) => {
  res.render('forums-thread', { title: req.thread.title, category: req.category, thread: req.thread, posts: await forums.listPosts(req.thread.id), canModerate: canModerate(req), selfMemberId: req.member.id, error: req.query.error || null });
});

router.post('/threads/:threadId/posts', loadThread, async (req, res) => {
  const moderator = canModerate(req);
  if ((req.thread.status !== 'active' || req.thread.is_locked) && !moderator) {
    return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('This thread is locked.'));
  }
  const body = (req.body.body || '').trim();
  if (!body) return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('A message is required.'));
  await forums.addPost(req.thread.id, body, req.member.id);
  if (req.thread.member_id && req.thread.member_id !== req.member.id) {
    await notifications.notify(req.thread.member_id, 'forum_reply', { title: `New reply: ${req.thread.title}`, body: 'Someone replied to your thread.', linkUrl: `/forums/threads/${req.thread.id}` });
  }
  res.redirect(`/forums/threads/${req.thread.id}`);
});

router.post('/threads/:threadId/posts/:postId/edit', loadThread, async (req, res) => {
  const post = await forums.getPost(req.params.postId);
  const isAuthor = post && post.member_id === req.member.id;
  if (!post || (!isAuthor && !canModerate(req))) {
    return res.status(403).render('403', { title: 'Not Authorized', message: 'You can only edit your own posts.' });
  }
  const body = (req.body.body || '').trim();
  if (!body) return res.redirect(`/forums/threads/${req.thread.id}?error=` + encodeURIComponent('A message is required.'));
  await forums.editPost(post.id, body);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

function requireModerator(req, res, next) {
  if (!canModerate(req)) return res.status(403).render('403', { title: 'Not Authorized', message: "You don't have permission to moderate chats." });
  next();
}

router.post('/threads/:threadId/posts/:postId/remove', loadThread, requireModerator, async (req, res) => {
  await forums.removePost(req.params.postId);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/posts/:postId/restore', loadThread, requireModerator, async (req, res) => {
  await forums.restorePost(req.params.postId);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/pin', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadPinned(req.thread.id, true);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unpin', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadPinned(req.thread.id, false);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/lock', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadLocked(req.thread.id, true);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unlock', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadLocked(req.thread.id, false);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/archive', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadArchived(req.thread.id, true);
  res.redirect(`/forums/threads/${req.thread.id}`);
});
router.post('/threads/:threadId/unarchive', loadThread, requireModerator, async (req, res) => {
  await forums.setThreadArchived(req.thread.id, false);
  res.redirect(`/forums/threads/${req.thread.id}`);
});

module.exports = router;
