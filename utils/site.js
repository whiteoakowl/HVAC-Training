// Website builder: block (section) definitions, validation, pages,
// revisions, media library and theme. Every field a block can hold is
// declared in BLOCKS, so the editor form, the saved JSON and the public
// renderer all come from one definition; anything not declared is dropped.
const crypto = require('crypto');
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');

// Field types: text, textarea, image (media id), link, select, bool
const BUTTONS = (n) => [
  { key: `button${n}_label`, label: `Button ${n} text`, type: 'text' },
  { key: `button${n}_link`, label: `Button ${n} link`, type: 'link' },
];
const BLOCKS = {
  announcement: {
    label: 'Announcement bar', icon: '📣', help: 'Thin colored bar at the top - great for emergency service or a seasonal offer.',
    fields: [{ key: 'text', label: 'Message', type: 'text' }, { key: 'phone', label: 'Phone number (tap to call)', type: 'text' }],
  },
  hero: {
    label: 'Hero banner', icon: '🖼️', help: 'Big headline with a background photo and call-to-action buttons.',
    fields: [
      { key: 'heading', label: 'Headline', type: 'text' }, { key: 'subheading', label: 'Sub-headline', type: 'textarea' },
      { key: 'image', label: 'Background photo', type: 'image' }, ...BUTTONS(1), ...BUTTONS(2),
      { key: 'align', label: 'Text alignment', type: 'select', options: [['left', 'Left'], ['center', 'Center']] },
      { key: 'overlay', label: 'Photo darkening', type: 'select', options: [['30', 'Light'], ['50', 'Medium'], ['70', 'Dark']] },
    ],
  },
  text: { label: 'Text', icon: '📝', help: 'Heading and paragraphs. Blank lines start a new paragraph.', fields: [{ key: 'heading', label: 'Heading', type: 'text' }, { key: 'body', label: 'Text', type: 'textarea' }] },
  image_text: {
    label: 'Image + text', icon: '🪟', help: 'A photo beside a heading, text and button.',
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' }, { key: 'body', label: 'Text', type: 'textarea' }, { key: 'image', label: 'Photo', type: 'image' },
      { key: 'image_side', label: 'Photo on the', type: 'select', options: [['left', 'Left'], ['right', 'Right']] },
      { key: 'button_label', label: 'Button text', type: 'text' }, { key: 'button_link', label: 'Button link', type: 'link' },
    ],
  },
  services: {
    label: 'Services grid', icon: '🧰', help: 'Cards listing what you offer.',
    fields: [{ key: 'heading', label: 'Heading', type: 'text' }, { key: 'intro', label: 'Intro', type: 'textarea' }],
    items: { max: 12, label: 'Service', fields: [{ key: 'title', label: 'Title', type: 'text' }, { key: 'text', label: 'Description', type: 'textarea' }, { key: 'image', label: 'Photo (optional)', type: 'image' }, { key: 'link', label: 'Link (optional)', type: 'link' }] },
  },
  cta: {
    label: 'Call to action', icon: '📞', help: 'A colored band with one big button.',
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' }, { key: 'body', label: 'Text', type: 'textarea' },
      { key: 'button_label', label: 'Button text', type: 'text' }, { key: 'button_link', label: 'Button link', type: 'link' },
      { key: 'style', label: 'Color', type: 'select', options: [['primary', 'Brand color'], ['accent', 'Accent color'], ['dark', 'Dark']] },
    ],
  },
  testimonials: {
    label: 'Testimonials', icon: '⭐', help: 'Real customer reviews (use real ones only).',
    fields: [{ key: 'heading', label: 'Heading', type: 'text' }],
    items: { max: 12, label: 'Review', fields: [{ key: 'quote', label: 'Review', type: 'textarea' }, { key: 'name', label: 'Customer name', type: 'text' }, { key: 'place', label: 'Town', type: 'text' }] },
  },
  faq: {
    label: 'FAQ', icon: '❓', help: 'Questions customers can tap to expand.',
    fields: [{ key: 'heading', label: 'Heading', type: 'text' }],
    items: { max: 20, label: 'Question', fields: [{ key: 'q', label: 'Question', type: 'text' }, { key: 'a', label: 'Answer', type: 'textarea' }] },
  },
  gallery: {
    label: 'Photo gallery', icon: '🖼', help: 'A grid of photos - completed installs, your team, your trucks.',
    fields: [{ key: 'heading', label: 'Heading', type: 'text' }],
    items: { max: 24, label: 'Photo', fields: [{ key: 'image', label: 'Photo', type: 'image' }, { key: 'caption', label: 'Caption', type: 'text' }] },
  },
  service_area: { label: 'Service area', icon: '🗺️', help: 'Where you work.', fields: [{ key: 'heading', label: 'Heading', type: 'text' }, { key: 'body', label: 'Towns / counties', type: 'textarea' }] },
  contact_info: {
    label: 'Contact details', icon: '☎️', help: 'Phone, email, address and hours from Company Settings, with an optional map.',
    fields: [{ key: 'heading', label: 'Heading', type: 'text' }, { key: 'show_map', label: 'Show map', type: 'bool' }],
  },
  request_form: {
    label: 'Service request form', icon: '🗓️', help: 'Customers request service or an estimate; it lands in Service Requests with no retyping.',
    fields: [
      { key: 'heading', label: 'Heading', type: 'text' }, { key: 'intro', label: 'Intro', type: 'textarea' },
      { key: 'default_type', label: 'Pre-selected request type', type: 'select', options: [['service', 'Service / repair'], ['estimate', 'Estimate'], ['maintenance', 'Maintenance'], ['emergency', 'Emergency']] },
    ],
  },
  spacer: { label: 'Spacer', icon: '↕️', help: 'Extra space between sections.', fields: [{ key: 'size', label: 'Size', type: 'select', options: [['small', 'Small'], ['medium', 'Medium'], ['large', 'Large']] }] },
};

const RESERVED = new Set(['login', 'logout', 'register', 'forgot', 'reset', 'home', 'portal', 'employee', 'service', 'customers', 'requests', 'jobs', 'dispatch', 'inventory', 'trucks',
  'invoices', 'accounting', 'manage', 'admin', 'account', 'estimates', 'purchasing', 'vendors', 'bills', 'expenses', 'agreements', 'payroll', 'announcements', 'messages', 'assets',
  'my', 'files', 'training', 'events', 'forums', 'documents', 'notifications', 'member-directory', 'api', 'e', 'i', 'media', 'website', 'css', 'js', 'uploads', 'site', 'index']);

// Links: same-site paths, anchors, tel:, mailto:, http(s) only.
function cleanLink(v) {
  const s = fmt.clean(v, 500);
  if (!s) return '';
  if (/^(\/(?!\/)|#|tel:|mailto:|https?:\/\/)/i.test(s) || /^\{\{\w+\}\}/.test(s)) return s;
  if (/^[\w-]+(\/[\w-]*)*(\?.*)?$/.test(s)) return '/' + s;
  return '';
}

function cleanField(f, v) {
  switch (f.type) {
    case 'image': return /^\d+$/.test(String(v || '')) ? String(v) : '';
    case 'link': return cleanLink(v);
    case 'select': return f.options.some((o) => o[0] === v) ? v : f.options[0][0];
    case 'bool': return v === '1' || v === true ? '1' : '0';
    case 'textarea': return fmt.clean(v, 4000) || '';
    default: return fmt.clean(v, 300) || '';
  }
}

// Builds a block's data from posted form fields (f_<key>, i<n>_<key>).
function blockFromForm(type, body) {
  const def = BLOCKS[type];
  if (!def) throw new Error('Unknown section type.');
  const data = {};
  for (const f of def.fields) data[f.key] = cleanField(f, body['f_' + f.key]);
  if (def.items) {
    data.items = [];
    for (let i = 0; i < def.items.max; i++) {
      if (body[`i${i}_remove`] === '1') continue;
      const item = {};
      for (const f of def.items.fields) item[f.key] = cleanField(f, body[`i${i}_${f.key}`]);
      if (Object.values(item).some((x) => x)) data.items.push(item);
    }
  }
  return data;
}

function blankBlock(type) {
  const def = BLOCKS[type];
  const data = {};
  for (const f of def.fields) data[f.key] = f.type === 'select' ? f.options[0][0] : f.type === 'bool' ? '0' : '';
  if (def.items) data.items = [];
  if (type === 'request_form') Object.assign(data, { heading: 'Request service', default_type: 'service' });
  if (type === 'contact_info') Object.assign(data, { heading: 'Contact us', show_map: '1' });
  return { type, id: 'b' + crypto.randomBytes(4).toString('hex'), data };
}

// ---------------------------------------------------------------- pages
async function listPages() {
  return db.prepare('SELECT id, slug, title, nav_label, show_in_nav, position, status, published_at, updated_at, (draft_json <> COALESCE(published_json, \'\')) AS "hasChanges" FROM site_pages ORDER BY position, id').all();
}

async function getPage(id) {
  const p = await db.prepare('SELECT * FROM site_pages WHERE id = ?').get(id);
  if (!p) return null;
  p.draft = JSON.parse(p.draft_json || '[]');
  p.published = p.published_json ? JSON.parse(p.published_json) : null;
  return p;
}

async function getPublishedBySlug(slug) {
  return db.prepare("SELECT * FROM site_pages WHERE slug = ? AND status = 'published' AND published_json IS NOT NULL").get(slug);
}

function cleanSlug(s) {
  const slug = String(s || '').toLowerCase().trim().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) throw new Error('Enter a page address (letters, numbers and dashes).');
  if (RESERVED.has(slug)) throw new Error(`"${slug}" is used by the business system - choose another address.`);
  return slug;
}

async function createPage({ title, slug, template }, memberId) {
  const t = fmt.clean(title, 100);
  if (!t) throw new Error('Enter a page title.');
  const s = cleanSlug(slug || t);
  if (await db.prepare('SELECT 1 AS x FROM site_pages WHERE slug = ?').get(s)) throw new Error(`A page at /${s} already exists.`);
  let blocks = [];
  if (template === 'copy-home') {
    const home = await db.prepare("SELECT draft_json FROM site_pages WHERE slug = 'home'").get();
    blocks = home ? JSON.parse(home.draft_json) : [];
  } else if (template === 'basic') {
    blocks = [blankBlock('hero'), blankBlock('text'), blankBlock('request_form')];
    blocks[0].data.heading = t;
  }
  const pos = await db.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM site_pages').get();
  const info = await db.prepare('INSERT INTO site_pages (slug, title, nav_label, position, draft_json, updated_by) VALUES (?, ?, ?, ?, ?, ?)').run(s, t, t, pos.p, JSON.stringify(blocks), memberId);
  return info.lastInsertRowid;
}

async function saveDraft(id, blocks, memberId) {
  await db.prepare('UPDATE site_pages SET draft_json = ?, updated_by = ?, updated_at = now_text() WHERE id = ?').run(JSON.stringify(blocks), memberId, id);
}

async function updateSettings(id, d, memberId) {
  const p = await getPage(id);
  if (!p) throw new Error('Page not found.');
  const title = fmt.clean(d.title, 100);
  if (!title) throw new Error('Enter a page title.');
  const slug = p.slug === 'home' ? 'home' : cleanSlug(d.slug);
  if (slug !== p.slug && (await db.prepare('SELECT 1 AS x FROM site_pages WHERE slug = ? AND id <> ?').get(slug, id))) throw new Error(`A page at /${slug} already exists.`);
  await db
    .prepare('UPDATE site_pages SET title = ?, slug = ?, nav_label = ?, show_in_nav = ?, seo_title = ?, seo_description = ?, updated_by = ?, updated_at = now_text() WHERE id = ?')
    .run(title, slug, fmt.clean(d.nav_label, 40) || title, d.show_in_nav === '1' ? 1 : 0, fmt.clean(d.seo_title, 120), fmt.clean(d.seo_description, 300), memberId, id);
}

async function publish(id, memberId) {
  const p = await getPage(id);
  if (!p) throw new Error('Page not found.');
  if (!p.draft.length) throw new Error('Add at least one section before publishing.');
  await db.withTransaction(async (tx) => {
    await tx.prepare("UPDATE site_pages SET published_json = draft_json, status = 'published', published_at = now_text(), updated_by = ? WHERE id = ?").run(memberId, id);
    await tx.prepare('INSERT INTO site_revisions (page_id, blocks_json, note, created_by) VALUES (?, ?, ?, ?)').run(id, p.draft_json, 'Published', memberId);
  });
}

async function unpublish(id) {
  const p = await getPage(id);
  if (!p) throw new Error('Page not found.');
  await db.prepare("UPDATE site_pages SET status = 'hidden' WHERE id = ?").run(id);
}

async function revisions(id) {
  return db.prepare('SELECT r.id, r.note, r.created_at, m.name AS "byName" FROM site_revisions r LEFT JOIN members m ON m.id = r.created_by WHERE r.page_id = ? ORDER BY r.id DESC LIMIT 30').all(id);
}

async function restoreRevision(pageId, revId, memberId) {
  const r = await db.prepare('SELECT * FROM site_revisions WHERE id = ? AND page_id = ?').get(revId, pageId);
  if (!r) throw new Error('Version not found.');
  await saveDraft(pageId, JSON.parse(r.blocks_json), memberId);
}

async function deletePage(id) {
  const p = await getPage(id);
  if (!p) throw new Error('Page not found.');
  if (p.slug === 'home') throw new Error("The home page can't be deleted.");
  await db.prepare('DELETE FROM site_pages WHERE id = ?').run(id);
}

async function reorderPages(ids) {
  let pos = 0;
  for (const id of ids) await db.prepare('UPDATE site_pages SET position = ? WHERE id = ?').run(pos++, parseInt(id, 10));
}

async function nav() {
  return db.prepare("SELECT slug, nav_label, title FROM site_pages WHERE status = 'published' AND show_in_nav = 1 AND published_json IS NOT NULL ORDER BY position, id").all();
}

async function isLive() {
  return Boolean(await getPublishedBySlug('home'));
}

// ---------------------------------------------------------------- media
const IMAGE_SIGNATURES = [
  ['image/png', (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['image/jpeg', (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => b.length > 6 && b.slice(0, 3).toString() === 'GIF'],
  ['image/webp', (b) => b.length > 12 && b.slice(0, 4).toString() === 'RIFF' && b.slice(8, 12).toString() === 'WEBP'],
];

// Only real PNG/JPEG/GIF/WebP files (checked by content, not by name).
// SVG is refused because it can carry scripts.
async function addMedia(file, alt, memberId) {
  if (!file) throw new Error('Choose an image.');
  const sig = IMAGE_SIGNATURES.find(([, test]) => test(file.buffer));
  if (!sig) throw new Error('Images must be PNG, JPG, GIF or WebP.');
  const info = await db
    .prepare('INSERT INTO site_media (file_name, mime_type, file_size, alt_text, content, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(file.originalname || 'image').slice(0, 150), sig[0], file.size, fmt.clean(alt, 200), file.buffer, memberId);
  return info.lastInsertRowid;
}

async function listMedia() {
  return db.prepare('SELECT id, file_name, mime_type, file_size, alt_text, created_at FROM site_media ORDER BY id DESC').all();
}

async function getMedia(id) {
  return db.prepare('SELECT * FROM site_media WHERE id = ?').get(id);
}

async function mediaInUse(id) {
  const rows = await db.prepare('SELECT title, draft_json, published_json FROM site_pages').all();
  const re = new RegExp(`"image":"${id}"`);
  const pages = rows.filter((r) => re.test(r.draft_json) || re.test(r.published_json || '')).map((r) => r.title);
  if (String(await settings.get('site_logo_media_id', '')) === String(id)) pages.push('Site logo');
  return pages;
}

async function deleteMedia(id) {
  const used = await mediaInUse(id);
  if (used.length) throw new Error(`This image is used on: ${used.join(', ')}. Remove it there first.`);
  await db.prepare('DELETE FROM site_media WHERE id = ?').run(id);
}

// ---------------------------------------------------------------- theme
const FONTS = {
  modern: { label: 'Modern (clean sans-serif)', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  classic: { label: 'Classic (serif headings)', stack: 'Georgia, "Times New Roman", serif' },
  rounded: { label: 'Friendly (rounded)', stack: '"Trebuchet MS", "Segoe UI", Verdana, sans-serif' },
  bold: { label: 'Bold (condensed headings)', stack: '"Arial Narrow", "Helvetica Neue", Arial, sans-serif' },
};

function cleanColor(v, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(String(v || '')) ? v : fallback;
}

async function theme() {
  const s = await settings.all();
  return {
    name: s.company_name || 'Our Company', tagline: s.site_tagline || '', logo: s.site_logo_media_id || '',
    primary: cleanColor(s.site_primary_color, '#0b4f8a'), accent: cleanColor(s.site_accent_color, '#e8590c'), font: FONTS[s.site_font] ? s.site_font : 'modern',
    phone: s.company_phone || '', emergencyPhone: s.site_emergency_phone || s.company_phone || '', email: s.company_email || '', address: s.company_address || '', hours: s.site_hours || '',
    ctaLabel: s.site_header_cta_label || '', ctaLink: cleanLink(s.site_header_cta_link) || '/request-service', footer: s.site_footer_text || '',
    social: { facebook: cleanLink(s.site_social_facebook), instagram: cleanLink(s.site_social_instagram), google: cleanLink(s.site_social_google) },
    staffLogin: s.site_show_staff_login !== '0',
  };
}

// {{company_name}} etc. inside any text field.
function fill(text, t) {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (m, k) => ({ company_name: t.name, company_phone: t.phone, emergency_phone: t.emergencyPhone, company_email: t.email, company_address: t.address, hours: t.hours }[k] ?? m));
}

module.exports = {
  BLOCKS, RESERVED, FONTS, cleanLink, blockFromForm, blankBlock, listPages, getPage, getPublishedBySlug, createPage, saveDraft, updateSettings, publish, unpublish,
  revisions, restoreRevision, deletePage, reorderPages, nav, isLive, addMedia, listMedia, getMedia, mediaInUse, deleteMedia, theme, fill, cleanColor,
};
