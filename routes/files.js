// Files attached to records (customer, job, employee, equipment, vendor):
// contracts, warranty papers, inspection reports, manuals, certifications,
// W-4s... Access follows the record's own permissions, not the shared
// document library's.
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const router = express.Router();
const { requireAuth, forbidden } = require('../middleware/auth');
const db = require('../db');
const documents = require('../utils/documents');
const jobs = require('../utils/jobs');
const audit = require('../utils/audit');
const fmt = require('../utils/format');
const { flash, action } = require('../utils/http');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
router.use('/files', requireAuth);

const BACK = {
  customer: (id) => `/customers/${id}#files`,
  job: (id) => `/jobs/${id}#files`,
  member: (id) => `/manage/employees/${id}#files`,
  equipment: async (id) => {
    const e = await db.prepare('SELECT p.customer_id FROM equipment e JOIN properties p ON p.id = e.property_id WHERE e.id = ?').get(id);
    return e ? `/customers/${e.customer_id}/equipment/${id}` : '/customers';
  },
  vendor: () => '/vendors',
};

async function allowed(req, target, id, mode) {
  const can = req.can;
  switch (target) {
    case 'customer':
    case 'equipment':
      return mode === 'view' ? can('customers.view') : can('customers.edit');
    case 'job': {
      if (can('jobs.manage') || (mode === 'view' && can('jobs.view_all'))) return true;
      return can('jobs.work', 'jobs.view_assigned') && (await jobs.isAssigned(id, req.member.id));
    }
    case 'member':
      return mode === 'view' ? can('employees.view') || String(id) === String(req.member.id) : can('employees.manage');
    case 'vendor':
      return can('purchasing.manage', 'bills.manage');
    default:
      return false;
  }
}

async function backUrl(target, id) {
  const f = BACK[target];
  return f ? f(id) : '/home';
}

router.post('/files/:target/:id', upload.single('file'), action(async (req, res) => {
  const { target } = req.params;
  const id = parseInt(req.params.id, 10);
  if (!documents.TARGET_COLUMN[target] || !id) throw new Error('Unknown record.');
  if (!(await allowed(req, target, id, 'edit'))) throw new Error("You don't have permission to add files here.");
  if (!req.file) throw new Error('Choose a file.');
  const docId = await documents.attach(target, id, {
    title: fmt.clean(req.body.title, 200) || req.file.originalname, description: fmt.clean(req.body.description, 1000), docType: fmt.clean(req.body.doc_type, 50),
    filePath: crypto.randomBytes(16).toString('hex') + path.extname(req.file.originalname).slice(0, 10), content: req.file.buffer, originalName: req.file.originalname, fileSize: req.file.size,
  }, req.member.id);
  await audit.log(req, 'file.attach', target, id, { docId, name: req.file.originalname });
  flash(res, await backUrl(target, id), 'notice', 'File attached.');
}, (req) => '/home'));

function targetOf(doc) {
  for (const [t, col] of Object.entries(documents.TARGET_COLUMN)) if (doc[col]) return [t, doc[col]];
  return [null, null];
}

router.get('/files/:docId', async (req, res) => {
  const doc = await documents.getDocument(req.params.docId);
  if (!doc) return res.status(404).render('404', { title: 'Not Found' });
  const [target, id] = targetOf(doc);
  if (!target) return res.redirect(`/documents/${doc.id}/download`);
  if (!(await allowed(req, target, id, 'view'))) return forbidden(res);
  const content = await documents.getFileContent(doc);
  if (!content) return res.status(404).render('404', { title: 'Not Found' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.attachment(doc.original_name || doc.title).send(Buffer.from(content));
});

router.post('/files/:docId/delete', action(async (req, res) => {
  const doc = await documents.getDocument(req.params.docId);
  if (!doc) throw new Error('File not found.');
  const [target, id] = targetOf(doc);
  if (!target || !(await allowed(req, target, id, 'edit'))) throw new Error("You don't have permission to remove this file.");
  await documents.deleteDocument(doc.id);
  await audit.log(req, 'file.delete', target, id, { docId: doc.id, name: doc.original_name });
  flash(res, await backUrl(target, id), 'notice', 'File removed.');
}, '/home'));

module.exports = router;
