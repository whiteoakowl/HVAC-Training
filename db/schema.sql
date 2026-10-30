-- HVAC Training Portal schema. Written for SQLite; db/postgres.js
-- rewrites the few SQLite-only bits (AUTOINCREMENT, datetime('now'),
-- BLOB) when running against Postgres/Supabase.
-- Single-role-per-account model: members.role is one of 'student',
-- 'instructor', 'admin' - simpler than the reference app's many-to-many
-- roles/permissions system, since this portal doesn't need a member to
-- hold multiple portals at once.

CREATE TABLE IF NOT EXISTS members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('student','instructor','admin')),
  phone TEXT,
  photo_path TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Event Calendar
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  location TEXT,
  category TEXT,
  starts_at TEXT NOT NULL,
  ends_at TEXT,
  capacity INTEGER,
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('public','members')),
  created_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS event_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'registered' CHECK (status IN ('registered','waitlisted','cancelled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (event_id, member_id)
);

-- ---------------------------------------------------------------------
-- Training & Learning
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trainings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  estimated_minutes INTEGER,
  passing_score INTEGER NOT NULL DEFAULT 80,
  sequential_lessons INTEGER NOT NULL DEFAULT 1,
  require_video_completion INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS training_lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('video','text','quiz')),
  position INTEGER NOT NULL DEFAULT 0,
  required INTEGER NOT NULL DEFAULT 1,
  video_url TEXT,
  content TEXT
);

CREATE TABLE IF NOT EXISTS training_quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER NOT NULL REFERENCES training_lessons(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  points INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS training_quiz_options (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question_id INTEGER NOT NULL REFERENCES training_quiz_questions(id) ON DELETE CASCADE,
  option_text TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS training_assignments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  training_id INTEGER NOT NULL REFERENCES trainings(id) ON DELETE CASCADE,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'not_started' CHECK (status IN ('not_started','in_progress','passed','failed','retry_required')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  current_lesson_id INTEGER,
  latest_score INTEGER,
  best_score INTEGER,
  due_at TEXT,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  UNIQUE (training_id, member_id)
);

CREATE TABLE IF NOT EXISTS training_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id INTEGER NOT NULL REFERENCES training_assignments(id) ON DELETE CASCADE,
  attempt_number INTEGER NOT NULL,
  passing_score_snapshot INTEGER NOT NULL,
  score INTEGER,
  passed INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS training_lesson_progress (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES training_attempts(id) ON DELETE CASCADE,
  lesson_id INTEGER NOT NULL,
  lesson_title_snapshot TEXT NOT NULL,
  lesson_type_snapshot TEXT NOT NULL,
  lesson_position_snapshot INTEGER NOT NULL,
  lesson_required_snapshot INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'locked' CHECK (status IN ('locked','available','in_progress','completed')),
  video_completed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS training_quiz_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attempt_id INTEGER NOT NULL REFERENCES training_attempts(id) ON DELETE CASCADE,
  question_id INTEGER NOT NULL,
  question_text_snapshot TEXT NOT NULL,
  points_possible_snapshot INTEGER NOT NULL,
  selected_option_id INTEGER,
  selected_option_text_snapshot TEXT,
  is_correct INTEGER NOT NULL DEFAULT 0,
  points_earned INTEGER NOT NULL DEFAULT 0,
  UNIQUE (attempt_id, question_id)
);

-- ---------------------------------------------------------------------
-- Member Directory
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS member_directory_field_settings (
  field_key TEXT PRIMARY KEY,
  visible INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS member_directory_opt_outs (
  member_id INTEGER PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- Communication (Notification Center)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  type_key TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT,
  link_url TEXT,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Chat (Forums)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forum_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT,
  is_locked INTEGER NOT NULL DEFAULT 0,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS forum_threads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER NOT NULL REFERENCES forum_categories(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  member_id INTEGER REFERENCES members(id),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  is_pinned INTEGER NOT NULL DEFAULT 0,
  is_locked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS forum_posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id INTEGER NOT NULL REFERENCES forum_threads(id) ON DELETE CASCADE,
  member_id INTEGER REFERENCES members(id),
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','removed')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  edited_at TEXT
);

-- ---------------------------------------------------------------------
-- Documents (new - has no member-facing equivalent in the reference app)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS document_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  position INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT,
  category_id INTEGER REFERENCES document_categories(id),
  file_path TEXT NOT NULL,
  original_name TEXT,
  file_size INTEGER,
  visibility TEXT NOT NULL DEFAULT 'members' CHECK (visibility IN ('members','instructors','admins')),
  uploaded_by INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- File contents live in the database (not on disk) so uploads persist on
-- serverless hosts like Netlify, where the filesystem is temporary.
CREATE TABLE IF NOT EXISTS document_files (
  file_path TEXT PRIMARY KEY,
  content BLOB NOT NULL
);
