// Company timezone: Eastern Time (New York). Times are stored as local
// wall-clock text in this zone and shown as MM/DD/YYYY h:mm AM/PM.
// (APP_TIMEZONE in the environment still overrides the setting.)
module.exports = {
  id: '004_eastern_time',
  sql: `
INSERT INTO settings (key, value) VALUES ('company_timezone', 'America/New_York') ON CONFLICT (key) DO UPDATE SET value = 'America/New_York';
`,
};
