// Netlify Scheduled Function: runs the daily automations (see
// utils/scheduler.js). Schedule is set in netlify.toml.
const { runDaily } = require('../../utils/scheduler');
const db = require('../../db');

exports.handler = async () => {
  await db.ready;
  const result = await runDaily({ origin: 'netlify-schedule' });
  return { statusCode: 200, body: JSON.stringify(result) };
};
