const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const documents = require('../utils/documents');
const notifications = require('../utils/notifications');
const db = require('../db');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'documents');

// Stores under a random filename (never the client-supplied original
// name) so a path-traversal or overwrite attempt via a crafted filename
// is structurally impossible - the real name is kept only in the DB's
// original_name column and reapplied as the Content-Disposition
// filename on download.
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + path.extname(file.originalname).slice(0, 10)),
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

router.use(requireAuth);

router.get('/', async (req, res) => {
  res.render('documents-list', { title: 'Documents', documents: await documents.listForRole(req.member.role) });
});

router.get('/manage', requireRole('instructor'), async (req, res) => {
  res.render('documents-manage', { title: 'Manage Documents', documents: await documents.listAll(), categories: await documents.listCategories(), notice: req.query.notice || null, error: req.query.error || null });
});

router.post('/manage/categories', requireRole('instructor'), async (req, res) => {
  const name = (req.body.name || '').trim();
  if (name) await documents.createCategory(name);
  res.redirect('/documents/manage');
});

router.post('/manage/upload', requireRole('instructor'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.redirect('/documents/manage?error=' + encodeURIComponent('Choose a file to upload.'));
  const id = await documents.createDocument(
    {
      title: (req.body.title || req.file.originalname).trim(),
      description: (req.body.description || '').trim(),
      categoryId: req.body.categoryId || null,
      filePath: req.file.filename,
      originalName: req.file.originalname,
      fileSize: req.file.size,
      visibility: ['members', 'instructors', 'admins'].includes(req.body.visibility) ? req.body.visibility : 'members',
    },
    req.member.id
  );
  const members = await db.prepare('SELECT id, role FROM members WHERE active = 1').all();
  for (const m of members) {
    if (documents.visibleToRole({ visibility: req.body.visibility || 'members' }, m.role) && m.id !== req.member.id) {
      await notifications.notify(m.id, 'document_added', { title: 'New Document Available', body: (req.body.title || req.file.originalname).trim(), linkUrl: '/documents' });
    }
  }
  res.redirect('/documents/manage?notice=' + encodeURIComponent('Document uploaded.'));
  void id;
});

router.post('/manage/:id/delete', requireRole('instructor'), async (req, res) => {
  const doc = await documents.deleteDocument(req.params.id);
  if (doc) {
    const fs = require('fs');
    fs.unlink(path.join(UPLOAD_DIR, doc.file_path), () => {});
  }
  res.redirect('/documents/manage?notice=' + encodeURIComponent('Document deleted.'));
});

router.get('/:id/download', async (req, res) => {
  const doc = await documents.getDocument(req.params.id);
  if (!doc || !documents.visibleToRole(doc, req.member.role)) return res.status(404).render('404', { title: 'Not Found' });
  res.download(path.join(UPLOAD_DIR, doc.file_path), doc.original_name || doc.title);
});

module.exports = router;
