// Accepts the common names hosts use for a Postgres connection string,
// but only values that actually are one (Netlify's Supabase extension,
// for instance, sets SUPABASE_DATABASE_URL to the https API URL).
const CANDIDATES = ['DATABASE_URL', 'SUPABASE_DB_URL', 'SUPABASE_DATABASE_URL', 'POSTGRES_URL'];

const postgresUrl =
  CANDIDATES.map((name) => process.env[name]).find((v) => v && /^postgres(ql)?:\/\//.test(v)) || null;

module.exports = { postgresUrl };
