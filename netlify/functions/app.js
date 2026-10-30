// Netlify Function wrapper: runs the whole Express app behind one
// function, with netlify.toml rewriting every non-static path to it.
// With DATABASE_URL set (Supabase) data persists; without it the app
// falls back to SQLite in /tmp, which resets on every cold start. Either
// way the seed runs first - it only inserts rows that are missing.
const serverless = require('serverless-http');
const app = require('../../server');
const seed = require('../../db/seed');

const seeded = seed();
const handler = serverless(app, { binary: ['application/*', 'image/*', 'font/*', 'audio/*', 'video/*'] });

exports.handler = async (event, context) => {
  await seeded;
  return handler(event, context);
};
