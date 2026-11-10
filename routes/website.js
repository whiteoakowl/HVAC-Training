// Website builder (staff side). Pages are lists of sections ("blocks");
// edits change the DRAFT, which you see in the live preview; "Publish"
// copies the draft to the public site and keeps a restorable version.
const express = require('express');
const multer = require('multer');
const router = express.Router();
const { requireAuth, requirePermission } = require('../middleware/auth');
const site = require('../utils/site');
const settings = require('../utils/settings');
const audit = require('../utils/audit');
const { flash, action, asArray } = require('../utils/http');
const { renderPage } = require('./site');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
router.use(requireAuth, requirePermission('website.manage'));

router.get('/', async (req, res) => {
  res.render('website-home', {
    title: 'Website', pages: await site.listPages(), media: await site.listMedia(), t: await site.theme(), s: await settings.all(), fonts: site.FONTS, live: await site.isLive(),
  });
});

router.post('/pages', action(async (req, res) => {
  const id = await site.createPage({ title: req.body.title, slug: req.body.slug, template: req.body.template }, req.member.id);
  await audit.log(req, 'website.page_create', 'site_page', id);
  flash(res, `/website/pages/${id}`, 'notice', 'Page created. Add and edit sections, then publish.');
}, '/website'));

router.post('/pages/order', async (req, res) => {
  await site.reorderPages(asArray(req.body.ids));
  res.json({ ok: true });
});

router.post('/theme', upload.single('logo'), action(async (req, res) => {
  const b = req.body;
  if (req.file) await settings.set('site_logo_media_id', await site.addMedia(req.file, 'Logo', req.member.id));
  if (b.remove_logo === '1') await settings.set('site_logo_media_id', '');
  const keys = { site_tagline: 100, site_emergency_phone: 40, site_hours: 200, site_header_cta_label: 40, site_footer_text: 300 };
  for (const [k, max] of Object.entries(keys)) await settings.set(k, String(b[k] || '').trim().slice(0, max));
  await settings.set('site_header_cta_link', site.cleanLink(b.site_header_cta_link) || '/request-service');
  await settings.set('site_primary_color', site.cleanColor(b.site_primary_color, '#0b4f8a'));
  await settings.set('site_accent_color', site.cleanColor(b.site_accent_color, '#e8590c'));
  await settings.set('site_font', site.FONTS[b.site_font] ? b.site_font : 'modern');
  for (const k of ['site_social_facebook', 'site_social_instagram', 'site_social_google']) await settings.set(k, site.cleanLink(b[k]));
  await settings.set('site_show_staff_login', b.site_show_staff_login === '1' ? '1' : '0');
  await audit.log(req, 'website.theme', null, null);
  flash(res, '/website#theme', 'notice', 'Look & feel saved. It applies to every published page right away.');
}, '/website'));

router.post('/media', upload.array('images', 12), action(async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw new Error('Choose one or more images.');
  for (const f of files) await site.addMedia(f, req.body.alt, req.member.id);
  await audit.log(req, 'website.media_upload', null, null, { count: files.length });
  const back = req.body.back && /^\/website(\/|$)/.test(req.body.back) ? req.body.back : '/website#media';
  flash(res, back, 'notice', `${files.length} image(s) uploaded.`);
}, (req) => (req.body && /^\/website(\/|$)/.test(req.body.back || '') ? req.body.back : '/website#media')));

router.post('/media/:id/delete', action(async (req, res) => {
  await site.deleteMedia(req.params.id);
  await audit.log(req, 'website.media_delete', 'site_media', req.params.id);
  flash(res, '/website#media', 'notice', 'Image deleted.');
}, '/website#media'));

// ---------------------------------------------------------------- page editor
async function load(req, res, next) {
  const p = await site.getPage(req.params.id);
  if (!p) return res.status(404).render('404', { title: 'Not Found' });
  req.page = p;
  next();
}
const back = (req) => `/website/pages/${req.params.id}`;

router.get('/pages/:id', load, async (req, res) => {
  res.render('website-editor', {
    title: `Edit ${req.page.title}`, p: req.page, BLOCKS: site.BLOCKS, media: await site.listMedia(), revisions: await site.revisions(req.page.id), open: req.query.open || '',
  });
});

router.get('/preview/:id', load, async (req, res) => {
  await renderPage(req, res, req.page, req.page.draft, { preview: true });
});

router.post('/pages/:id/settings', load, action(async (req, res) => {
  await site.updateSettings(req.page.id, req.body, req.member.id);
  await audit.log(req, 'website.page_settings', 'site_page', req.page.id);
  flash(res, back(req), 'notice', 'Page settings saved.');
}, back));

router.post('/pages/:id/blocks', load, action(async (req, res) => {
  if (!site.BLOCKS[req.body.type]) throw new Error('Choose a section type.');
  const blocks = req.page.draft.slice();
  const b = site.blankBlock(req.body.type);
  const at = Math.max(0, Math.min(blocks.length, parseInt(req.body.at, 10) >= 0 ? parseInt(req.body.at, 10) : blocks.length));
  blocks.splice(at, 0, b);
  await site.saveDraft(req.page.id, blocks, req.member.id);
  res.redirect(`${back(req)}?open=${b.id}#blk-${b.id}`);
}, back));

router.post('/pages/:id/blocks/:bid', load, action(async (req, res) => {
  const blocks = req.page.draft.slice();
  const i = blocks.findIndex((b) => b.id === req.params.bid);
  if (i < 0) throw new Error('Section not found.');
  blocks[i] = { ...blocks[i], data: site.blockFromForm(blocks[i].type, req.body) };
  await site.saveDraft(req.page.id, blocks, req.member.id);
  if (req.get('x-requested-with') === 'fetch') return res.json({ ok: true });
  res.redirect(`${back(req)}?open=${req.params.bid}&notice=${encodeURIComponent('Saved to draft.')}#blk-${req.params.bid}`);
}, back));

router.post('/pages/:id/blocks/:bid/:op', load, action(async (req, res) => {
  const blocks = req.page.draft.slice();
  const i = blocks.findIndex((b) => b.id === req.params.bid);
  if (i < 0) throw new Error('Section not found.');
  const op = req.params.op;
  if (op === 'delete') blocks.splice(i, 1);
  else if (op === 'up' && i > 0) [blocks[i - 1], blocks[i]] = [blocks[i], blocks[i - 1]];
  else if (op === 'down' && i < blocks.length - 1) [blocks[i + 1], blocks[i]] = [blocks[i], blocks[i + 1]];
  else if (op === 'duplicate') blocks.splice(i + 1, 0, { ...JSON.parse(JSON.stringify(blocks[i])), id: site.blankBlock(blocks[i].type).id });
  else if (!['up', 'down'].includes(op)) throw new Error('Unknown action.');
  await site.saveDraft(req.page.id, blocks, req.member.id);
  res.redirect(back(req) + (op === 'delete' ? '' : `?open=${req.params.bid}#blk-${req.params.bid}`));
}, back));

// Drag-and-drop reorder from the editor.
router.post('/pages/:id/order', load, async (req, res) => {
  const ids = asArray(req.body.ids);
  const blocks = req.page.draft;
  if (ids.length !== blocks.length || !ids.every((id) => blocks.some((b) => b.id === id))) return res.status(400).json({ ok: false, error: 'The page changed - reload and try again.' });
  await site.saveDraft(req.page.id, ids.map((id) => blocks.find((b) => b.id === id)), req.member.id);
  res.json({ ok: true });
});

router.post('/pages/:id/publish', load, action(async (req, res) => {
  await site.publish(req.page.id, req.member.id);
  await audit.log(req, 'website.publish', 'site_page', req.page.id);
  flash(res, back(req), 'notice', `Published. It's live at ${req.page.slug === 'home' ? '/' : '/' + req.page.slug}.`);
}, back));

router.post('/pages/:id/unpublish', load, action(async (req, res) => {
  await site.unpublish(req.page.id);
  await audit.log(req, 'website.unpublish', 'site_page', req.page.id);
  flash(res, back(req), 'notice', req.page.slug === 'home' ? 'Home page hidden - the site address now goes to the staff login.' : 'Page hidden from the public site.');
}, back));

router.post('/pages/:id/discard', load, action(async (req, res) => {
  if (!req.page.published) throw new Error('This page has never been published - there is nothing to go back to.');
  await site.saveDraft(req.page.id, req.page.published, req.member.id);
  flash(res, back(req), 'notice', 'Draft reset to the published version.');
}, back));

router.post('/pages/:id/restore/:rev', load, action(async (req, res) => {
  await site.restoreRevision(req.page.id, req.params.rev, req.member.id);
  await audit.log(req, 'website.restore', 'site_page', req.page.id, { revision: req.params.rev });
  flash(res, back(req), 'notice', 'Earlier version loaded into the draft. Publish to make it live.');
}, back));

router.post('/pages/:id/delete', load, action(async (req, res) => {
  await site.deletePage(req.page.id);
  await audit.log(req, 'website.page_delete', 'site_page', req.page.id, { slug: req.page.slug });
  flash(res, '/website', 'notice', 'Page deleted.');
}, back));

module.exports = router;
