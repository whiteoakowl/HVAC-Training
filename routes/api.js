// Machine-to-machine API. The company website is built into this app
// (see routes/website.js and routes/site.js), so there is no external
// website integration here.
const express = require('express');
const router = express.Router();

router.get('/health', (req, res) => res.json({ ok: true }));

module.exports = router;
