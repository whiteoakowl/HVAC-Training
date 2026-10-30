// Netlify Function wrapper: runs the whole Express app behind one
// function, with netlify.toml rewriting every non-static path to it.
// The SQLite DB lives in /tmp (see utils/paths.js), so each cold start
// gets a fresh database that is seeded with the demo accounts first.
const serverless = require('serverless-http');
const app = require('../../server');
const seed = require('../../db/seed');

const seeded = seed();
const handler = serverless(app, { binary: ['application/*', 'image/*', 'font/*', 'audio/*', 'video/*'] });

exports.handler = async (event, context) => {
  await seeded;
  return handler(event, context);
};
