// Documents - has no member-facing equivalent in the reference app
// (Document upload/management there only ever existed on the admin
// side), so this is built from scratch: instructors/admins upload
// files, students browse and download. visibility follows the same
// student/instructor/admin rank as middleware/auth.js's requireRole -
// 'members' is visible to everyone, 'instructors' hides it from
// students, 'admins' hides it from everyone but admins.
const db = require('../db');

// Visibility tiers map onto permissions (originally the student <
// instructor < admin rank): 'instructors' = anyone who can manage
// documents, 'admins' = anyone who can manage user accounts.
const VISIBILITY_PERMISSION = { members: null, instructors: 'documents.manage', admins: 'users.manage' };

async function listCategories() {
  return db.prepare('SELECT * FROM document_categories ORDER BY position, id').all();
}

async function createCategory(name) {
  const info = await db.prepare('INSERT INTO document_categories (name) VALUES (?)').run(name);
  return info.lastInsertRowid;
}

// `can` is a permission checker (req.can / permissions.makeChecker).
function visibleToRole(doc, can) {
  const needed = VISIBILITY_PERMISSION[doc.visibility];
  return needed ? can(needed) : can('documents.view', 'documents.manage');
}

// Shared library only: files attached to a customer, job, employee,
// equipment or vendor record are shown (and permission-checked) there.
const LINKED = 'd.customer_id IS NULL AND d.job_id IS NULL AND d.member_id IS NULL AND d.equipment_id IS NULL AND d.vendor_id IS NULL';

async function listForRole(can, q = null) {
  const params = [];
  let search = '';
  if (q) {
    search = " AND (LOWER(d.title) LIKE ? OR LOWER(COALESCE(d.description, '')) LIKE ? OR LOWER(COALESCE(d.original_name, '')) LIKE ?)";
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  const all = await db
    .prepare(`SELECT d.*, c.name AS "categoryName", m.name AS "uploadedByName" FROM documents d LEFT JOIN document_categories c ON c.id = d.category_id LEFT JOIN members m ON m.id = d.uploaded_by WHERE ${LINKED}${search} ORDER BY d.created_at DESC`)
    .all(...params);
  return all.filter((d) => visibleToRole(d, can));
}

async function listAll() {
  return db
    .prepare(`SELECT d.*, c.name AS "categoryName", m.name AS "uploadedByName" FROM documents d LEFT JOIN document_categories c ON c.id = d.category_id LEFT JOIN members m ON m.id = d.uploaded_by WHERE ${LINKED} ORDER BY d.created_at DESC`)
    .all();
}

// Files attached to one record. target: customer | job | member | equipment | vendor
const TARGET_COLUMN = { customer: 'customer_id', job: 'job_id', member: 'member_id', equipment: 'equipment_id', vendor: 'vendor_id' };
async function listFor(target, id) {
  const col = TARGET_COLUMN[target];
  if (!col) return [];
  return db.prepare(`SELECT d.id, d.title, d.doc_type, d.original_name, d.file_size, d.created_at, m.name AS "uploadedByName" FROM documents d LEFT JOIN members m ON m.id = d.uploaded_by WHERE d.${col} = ? ORDER BY d.id DESC`).all(id);
}

async function attach(target, id, data, uploadedBy) {
  const col = TARGET_COLUMN[target];
  if (!col) throw new Error('Unknown record type.');
  await db.prepare('INSERT INTO document_files (file_path, content) VALUES (?, ?)').run(data.filePath, data.content);
  const info = await db
    .prepare(`INSERT INTO documents (title, description, file_path, original_name, file_size, visibility, uploaded_by, doc_type, ${col}) VALUES (?, ?, ?, ?, ?, 'admins', ?, ?, ?)`)
    .run(data.title, data.description || null, data.filePath, data.originalName, data.fileSize, uploadedBy, data.docType || null, id);
  return info.lastInsertRowid;
}

async function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

async function createDocument(data, uploadedBy) {
  await db.prepare('INSERT INTO document_files (file_path, content) VALUES (?, ?)').run(data.filePath, data.content);
  const info = await db
    .prepare('INSERT INTO documents (title, description, category_id, file_path, original_name, file_size, visibility, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(data.title, data.description || null, data.categoryId || null, data.filePath, data.originalName || null, data.fileSize || null, data.visibility || 'members', uploadedBy);
  return info.lastInsertRowid;
}

async function deleteDocument(id) {
  const doc = await getDocument(id);
  await db.prepare('DELETE FROM documents WHERE id = ?').run(id);
  if (doc) await db.prepare('DELETE FROM document_files WHERE file_path = ?').run(doc.file_path);
  return doc;
}

async function getFileContent(doc) {
  const row = await db.prepare('SELECT content FROM document_files WHERE file_path = ?').get(doc.file_path);
  return row ? row.content : null;
}

module.exports = { TARGET_COLUMN, listFor, attach, listCategories, createCategory, listForRole, listAll, getDocument, createDocument, deleteDocument, getFileContent, visibleToRole };
