// Installable app (PWA) support: the web app manifest phones read when
// the app is installed. The service worker, offline page and icons are
// static files in public/. The app is always named "HVAC Pro" (the
// same name iPhone uses via apple-mobile-web-app-title in the page head).
const express = require('express');
const router = express.Router();

const APP_NAME = 'HVAC Pro';

const MANIFEST = JSON.stringify({
  id: '/',
  name: APP_NAME,
  short_name: APP_NAME,
  description: `${APP_NAME} - jobs, time clock, customers, invoicing and training.`,
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
});

router.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json');
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(MANIFEST);
});

module.exports = router;
