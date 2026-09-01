// Chat (Forums): categories -> threads -> posts, plus moderation
// (edit-any/remove/lock/pin/archive) gated to instructor/admin. Every
// category here is open to any signed-in member - unlike the reference
// app's private per-class categories, this portal has no class-
// enrollment concept to scope a category to.
const db = require('../db');

async function listCategories() {
  return db.prepare('SELECT * FROM forum_categories ORDER BY position, id').all();
}

async function getCategory(id) {
  return db.prepare('SELECT * FROM forum_categories WHERE id = ?').get(id);
}

async function createCategory(name, description) {
  const info = await db.prepare('INSERT INTO forum_categories (name, description) VALUES (?, ?)').run(name, description || null);
  return info.lastInsertRowid;
}

async function setCategoryLocked(id, locked) {
  await db.prepare('UPDATE forum_categories SET is_locked = ? WHERE id = ?').run(locked ? 1 : 0, id);
}

async function deleteCategory(id) {
  await db.prepare('DELETE FROM forum_categories WHERE id = ?').run(id);
}

async function listThreads(categoryId) {
  return db
    .prepare(
      `SELECT t.*, m.name AS "authorName",
        COALESCE((SELECT MAX(p.created_at) FROM forum_posts p WHERE p.thread_id = t.id AND p.status = 'active'), t.created_at) AS "lastActivityAt",
        (SELECT COUNT(*) FROM forum_posts p WHERE p.thread_id = t.id AND p.status = 'active') AS "postCount"
       FROM forum_threads t LEFT JOIN members m ON m.id = t.member_id
       WHERE t.category_id = ? ORDER BY t.is_pinned DESC, "lastActivityAt" DESC`
    )
    .all(categoryId);
}

async function getThread(id) {
  return db.prepare(`SELECT t.*, m.name AS "authorName" FROM forum_threads t LEFT JOIN members m ON m.id = t.member_id WHERE t.id = ?`).get(id);
}

async function createThread(categoryId, title, body, memberId) {
  const threadInfo = await db.prepare('INSERT INTO forum_threads (category_id, title, member_id) VALUES (?, ?, ?)').run(categoryId, title, memberId);
  const threadId = threadInfo.lastInsertRowid;
  await db.prepare('INSERT INTO forum_posts (thread_id, member_id, body) VALUES (?, ?, ?)').run(threadId, memberId, body);
  return threadId;
}

async function listPosts(threadId) {
  return db.prepare(`SELECT p.*, m.name AS "authorName" FROM forum_posts p LEFT JOIN members m ON m.id = p.member_id WHERE p.thread_id = ? ORDER BY p.created_at`).all(threadId);
}

async function addPost(threadId, body, memberId) {
  const info = await db.prepare('INSERT INTO forum_posts (thread_id, member_id, body) VALUES (?, ?, ?)').run(threadId, memberId, body);
  await db.prepare('UPDATE forum_threads SET updated_at = now_text() WHERE id = ?').run(threadId);
  return info.lastInsertRowid;
}

async function getPost(id) {
  return db.prepare('SELECT * FROM forum_posts WHERE id = ?').get(id);
}

async function editPost(id, body) {
  await db.prepare('UPDATE forum_posts SET body = ?, edited_at = now_text() WHERE id = ?').run(body, id);
}

async function removePost(id) {
  await db.prepare("UPDATE forum_posts SET status = 'removed' WHERE id = ?").run(id);
}

async function restorePost(id) {
  await db.prepare("UPDATE forum_posts SET status = 'active' WHERE id = ?").run(id);
}

async function setThreadPinned(id, pinned) {
  await db.prepare('UPDATE forum_threads SET is_pinned = ?, updated_at = now_text() WHERE id = ?').run(pinned ? 1 : 0, id);
}

async function setThreadLocked(id, locked) {
  await db.prepare('UPDATE forum_threads SET is_locked = ?, updated_at = now_text() WHERE id = ?').run(locked ? 1 : 0, id);
}

async function setThreadArchived(id, archived) {
  await db.prepare("UPDATE forum_threads SET status = ?, updated_at = now_text() WHERE id = ?").run(archived ? 'archived' : 'active', id);
}

module.exports = {
  listCategories,
  getCategory,
  createCategory,
  setCategoryLocked,
  deleteCategory,
  listThreads,
  getThread,
  createThread,
  listPosts,
  addPost,
  getPost,
  editPost,
  removePost,
  restorePost,
  setThreadPinned,
  setThreadLocked,
  setThreadArchived,
};
