// Built-in website builder (replaces the Wix integration): pages made of
// sections ("blocks"), stored as JSON with separate draft and published
// copies, a revision history, a media library (images stored in the
// database), and site-wide theme settings. Starter pages are created as
// DRAFTS - nothing is public until someone publishes the home page.
const q = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);

const HOME = [
  { type: 'announcement', id: 'b1', data: { text: '24/7 emergency heating & cooling service', phone: '{{emergency_phone}}' } },
  { type: 'hero', id: 'b2', data: {
    heading: 'Heating & cooling you can count on', subheading: '{{company_name}} keeps homes and businesses comfortable year-round - repairs, installations and maintenance by licensed technicians.',
    button1_label: 'Request Service', button1_link: '/request-service', button2_label: 'Request an Estimate', button2_link: '/request-service?type=estimate', align: 'left', overlay: '50', image: '' } },
  { type: 'services', id: 'b3', data: { heading: 'What we do', intro: '', items: [
    { title: 'Residential HVAC', text: 'Furnaces, air conditioners, heat pumps and ductless systems for your home.' },
    { title: 'Commercial HVAC', text: 'Rooftop units, split systems and preventive maintenance for businesses.' },
    { title: 'Heating', text: 'Furnace and boiler repair, safety inspections and replacements.' },
    { title: 'Cooling', text: 'AC repair, tune-ups and high-efficiency system installations.' },
    { title: 'Maintenance Plans', text: 'Two tune-ups a year, priority scheduling and repair discounts.' },
    { title: 'Financing', text: 'Flexible payment options on new equipment - ask about current offers.' },
  ] } },
  { type: 'cta', id: 'b4', data: { heading: 'No heat? No cooling?', body: 'Call now - we answer around the clock.', button_label: 'Call {{emergency_phone}}', button_link: 'tel:{{emergency_phone}}', style: 'accent' } },
  { type: 'testimonials', id: 'b5', data: { heading: 'What our customers say', items: [
    { quote: '[Add a real customer review here before publishing]', name: '[Customer name]', place: '[Town]' },
  ] } },
  { type: 'service_area', id: 'b6', data: { heading: 'Areas we serve', body: '[List the towns and counties you cover]' } },
  { type: 'request_form', id: 'b7', data: { heading: 'Schedule service', intro: "Tell us what's going on and we'll call you to confirm a time.", default_type: 'service' } },
];

const PAGES = [
  ['home', 'Home', 'Home', 1, 0, HOME],
  ['services', 'Services', 'Services', 1, 1, [
    { type: 'hero', id: 'b1', data: { heading: 'Our services', subheading: 'Repair, replacement and maintenance for every kind of heating and cooling system.', button1_label: 'Request Service', button1_link: '/request-service', button2_label: '', button2_link: '', align: 'left', overlay: '50', image: '' } },
    { ...HOME[2], id: 'b2' },
    { type: 'image_text', id: 'b3', data: { heading: 'Residential', body: 'From a quick repair to a whole-home system replacement, our technicians explain your options and give you an upfront price before any work begins.', image: '', image_side: 'right', button_label: 'Request an Estimate', button_link: '/request-service?type=estimate' } },
    { type: 'image_text', id: 'b4', data: { heading: 'Commercial', body: 'Planned maintenance, emergency response and equipment upgrades for offices, retail and light industrial buildings.', image: '', image_side: 'left', button_label: 'Contact us', button_link: '/contact' } },
    { type: 'faq', id: 'b5', data: { heading: 'Common questions', items: [
      { q: 'How often should my system be serviced?', a: 'Once a year for each system - heating before winter and cooling before summer. Heat pumps run all year, so twice a year is best.' },
      { q: 'How often should I change my filter?', a: 'Every 1-3 months for standard 1-inch filters; check monthly during heavy use.' },
    ] } },
  ]],
  ['maintenance-plans', 'Maintenance Plans', 'Maintenance Plans', 1, 2, [
    { type: 'hero', id: 'b1', data: { heading: 'Maintenance plans', subheading: 'Fewer breakdowns, lower energy bills and longer equipment life.', button1_label: 'Join a plan', button1_link: '/request-service?type=maintenance', button2_label: '', button2_link: '', align: 'left', overlay: '50', image: '' } },
    { type: 'text', id: 'b2', data: { heading: "What's included", body: '[Describe your plan: number of visits, what each tune-up covers, repair discounts, priority scheduling, price.]' } },
    { type: 'request_form', id: 'b3', data: { heading: 'Sign up or ask a question', intro: '', default_type: 'maintenance' } },
  ]],
  ['about', 'About Us', 'About', 1, 3, [
    { type: 'text', id: 'b1', data: { heading: 'About {{company_name}}', body: '[Tell your story: how long you have been in business, licensing and insurance, what makes your team different.]' } },
  ]],
  ['contact', 'Contact', 'Contact', 1, 4, [
    { type: 'contact_info', id: 'b1', data: { heading: 'Contact us', show_map: '1' } },
    { type: 'request_form', id: 'b2', data: { heading: 'Send us a message', intro: '', default_type: 'service' } },
  ]],
  ['request-service', 'Request Service', 'Request Service', 0, 5, [
    { type: 'request_form', id: 'b1', data: { heading: 'Request service or an estimate', intro: "We'll contact you to confirm your appointment. For emergencies call {{emergency_phone}}.", default_type: 'service' } },
  ]],
];

function sql() {
  const out = [`
CREATE TABLE IF NOT EXISTS site_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  nav_label TEXT,
  show_in_nav INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0,
  seo_title TEXT,
  seo_description TEXT,
  draft_json TEXT NOT NULL DEFAULT '[]',
  published_json TEXT,
  published_at TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','hidden')),
  updated_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES site_pages(id) ON DELETE CASCADE,
  blocks_json TEXT NOT NULL,
  note TEXT,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS site_media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  file_size INTEGER NOT NULL,
  alt_text TEXT,
  content BLOB NOT NULL,
  created_by INTEGER REFERENCES members(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO permissions (key, label, module) VALUES ('website.manage', 'Edit and publish the company website', 'Website') ON CONFLICT (key) DO NOTHING;
INSERT INTO role_permissions (role_key, permission_key) SELECT 'general_manager', 'website.manage' WHERE EXISTS (SELECT 1 FROM roles WHERE key = 'general_manager') ON CONFLICT DO NOTHING;
INSERT INTO role_permissions (role_key, permission_key) SELECT 'office_manager', 'website.manage' WHERE EXISTS (SELECT 1 FROM roles WHERE key = 'office_manager') ON CONFLICT DO NOTHING;
`];
  for (const [slug, title, nav, inNav, pos, blocks] of PAGES) {
    out.push(`INSERT INTO site_pages (slug, title, nav_label, show_in_nav, position, draft_json) VALUES (${q(slug)}, ${q(title)}, ${q(nav)}, ${inNav}, ${pos}, ${q(JSON.stringify(blocks))}) ON CONFLICT (slug) DO NOTHING;`);
  }
  const SETTINGS = {
    site_tagline: 'Heating & Air Conditioning',
    site_logo_media_id: '',
    site_primary_color: '#0b4f8a',
    site_accent_color: '#e8590c',
    site_font: 'modern',
    site_emergency_phone: '',
    site_hours: 'Mon-Fri 7am-6pm · 24/7 emergency service',
    site_header_cta_label: 'Request Service',
    site_header_cta_link: '/request-service',
    site_footer_text: 'Licensed & insured.',
    site_social_facebook: '',
    site_social_instagram: '',
    site_social_google: '',
    site_show_staff_login: '1',
  };
  for (const [k, v] of Object.entries(SETTINGS)) out.push(`INSERT INTO settings (key, value) VALUES (${q(k)}, ${q(v)}) ON CONFLICT (key) DO NOTHING;`);
  return out.join('\n');
}

module.exports = { id: '005_website_builder', sql, PAGES };
