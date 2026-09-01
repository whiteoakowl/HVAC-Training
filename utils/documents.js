// Documents - has no member-facing equivalent in the reference app
// (Document upload/management there only ever existed on the admin
// side), so this is built from scratch: instructors/admins upload
// files, students browse and download. visibility follows the same
// student/instructor/admin rank as middleware/auth.js's requireRole -
// 'members' is visible to everyone, 'instructors' hides it from
// students, 'admins' hides it from everyone but admins.
const db = require('../db');

const RANK = { student: 1, instructor: 2, admin: 3 };
const VISIBILITY_MIN_ROLE = { members: 'student', instructors: 'instructor', admins: 'admin' };

async function listCategories() {
  return db.prepare('SELECT * FROM document_categories ORDER BY position, id').all();
}

async function createCategory(name) {
  const info = await db.prepare('INSERT INTO document_categories (name) VALUES (?)').run(name);
  return info.lastInsertRowid;
}

function visibleToRole(doc, role) {
  return RANK[role] >= RANK[VISIBILITY_MIN_ROLE[doc.visibility] || 'student'];
}

async function listForRole(role) {
  const all = await db
    .prepare(`SELECT d.*, c.name AS "categoryName", m.name AS "uploadedByName" FROM documents d LEFT JOIN document_categories c ON c.id = d.category_id LEFT JOIN members m ON m.id = d.uploaded_by ORDER BY d.created_at DESC`)
    .all();
  return all.filter((d) => visibleToRole(d, role));
}

async function listAll() {
  return db
    .prepare(`SELECT d.*, c.name AS "categoryName", m.name AS "uploadedByName" FROM documents d LEFT JOIN document_categories c ON c.id = d.category_id LEFT JOIN members m ON m.id = d.uploaded_by ORDER BY d.created_at DESC`)
    .all();
}

async function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

async function createDocument(data, uploadedBy) {
  const info = await db
    .prepare('INSERT INTO documents (title, description, category_id, file_path, original_name, file_size, visibility, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.title, data.description || null, data.categoryId || null, data.filePath, data.originalName || null, data.fileSize || null, data.visibility || 'members', uploadedBy);
  return info.lastInsertRowid;
}

async function deleteDocument(id) {
  const doc = await getDocument(id);
  await db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  return doc;
}

module.exports = { listCategories, createCategory, listForRole, listAll, getDocument, createDocument, deleteDocument, visibleToRole };
