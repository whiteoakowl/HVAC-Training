// Installable app (PWA) support. The manifest is served from here rather
// than public/ so the installed app is named after the company (Company
// Settings -> company name), falling back to "HVAC Pro". The service
// worker, offline page and icons are static files in public/.
const express = require('express');
const router = express.Router();
const settings = require('../utils/settings');

const DEFAULT_NAME = 'HVAC Pro';

router.get('/manifest.webmanifest', async (req, res) => {
  let name = DEFAULT_NAME;
  try {
    name = String((await settings.get('company_name', '')) || '').trim() || DEFAULT_NAME;
  } catch (err) {
    // Settings unavailable: still serve a working manifest.
  }
  const shortName = name.length > 12 ? name.split(/\s+/)[0].slice(0, 12) : name;
  res.type('application/manifest+json');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(JSON.stringify({
    id: '/',
    name,
    short_name: shortName,
    description: `${name} - jobs, time clock, customers, invoicing and training.`,
    start_url: '/login?source=pwa',
    scope: '/',
    display: 'standalone',
    orientation: 'any',
    background_color: '#f4f6f8',
    theme_color: '#1f6feb',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }));
});

module.exports = router;
