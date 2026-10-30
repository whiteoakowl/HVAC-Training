// Picks the database driver. With a Postgres connection string (e.g. a
// Supabase project's) in DATABASE_URL the app uses Postgres; otherwise it
// falls back to a local SQLite file. Both drivers expose the same
// prepare(sql).get/.all/.run() + withTransaction() API.
const { postgresUrl } = require('./config');

module.exports = postgresUrl ? require('./postgres') : require('./sqlite');
