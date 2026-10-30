// Seeds a demo admin/instructor/student and a handful of sample rows for
// each of the 6 features, so the app is browsable immediately after
// `npm run seed`. Safe to re-run - every insert is skipped when a row
// with the same natural key already exists.
const db = require('./index');
const { createMember, findByEmail } = require('../utils/auth');

async function ensureMember(name, email, password, role) {
  const existing = await findByEmail(email);
  if (existing) return existing.id;
  return createMember({ name, email, password, role });
}

// Set SEED_PASSWORD on a public deployment so the demo admin account
// doesn't keep the well-known default password.
const PASSWORD = process.env.SEED_PASSWORD || 'password123';

async function main() {
  const adminId = await ensureMember('Pat Reyes', 'admin@hvactraining.test', PASSWORD, 'admin');
  const instructorId = await ensureMember('Sam Kowalski', 'instructor@hvactraining.test', PASSWORD, 'instructor');
  const studentId = await ensureMember('Jordan Lee', 'student@hvactraining.test', PASSWORD, 'student');
  await ensureMember('Casey Nguyen', 'student2@hvactraining.test', PASSWORD, 'student');

  if (!(await db.prepare('SELECT 1 FROM events LIMIT 1').get())) {
    const info = await db
      .prepare('INSERT INTO events (title, description, location, category, starts_at, capacity, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run('Refrigerant Handling Workshop', 'Hands-on EPA 608 refrigerant handling practice.', 'Shop Bay 2', 'Workshop', '2026-09-15 09:00:00', 20, 'members', adminId);
    await db.prepare('INSERT INTO event_registrations (event_id, member_id) VALUES (?, ?)').run(info.lastInsertRowid, studentId);
    await db
      .prepare('INSERT INTO events (title, description, location, category, starts_at, visibility, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run('Open House', 'Tour the training facility - open to the public.', 'Main Campus', 'Community', '2026-09-20 17:00:00', 'public', adminId);
  }

  if (!(await db.prepare('SELECT 1 FROM trainings LIMIT 1').get())) {
    const tInfo = await db
      .prepare('INSERT INTO trainings (title, description, estimated_minutes, passing_score, status) VALUES (?, ?, ?, ?, ?)')
      .run('EPA 608 Core Safety', 'Required safety training before working with refrigerants.', 30, 80, 'published');
    const trainingId = tInfo.lastInsertRowid;
    const l1 = await db
      .prepare('INSERT INTO training_lessons (training_id, title, type, position, required, content) VALUES (?, ?, ?, ?, 1, ?)')
      .run(trainingId, 'Introduction to Refrigerant Safety', 'text', 0, '<p>Refrigerants can cause frostbite and asphyxiation. Always work in ventilated spaces and wear PPE.</p>');
    const l2 = await db
      .prepare('INSERT INTO training_lessons (training_id, title, type, position, required) VALUES (?, ?, ?, ?, 1)')
      .run(trainingId, 'Knowledge Check', 'quiz', 1);
    const q1 = await db
      .prepare('INSERT INTO training_quiz_questions (lesson_id, question, points, position) VALUES (?, ?, 1, 0)')
      .run(l2.lastInsertRowid, 'What PPE is required when handling refrigerant?');
    await db.prepare('INSERT INTO training_quiz_options (question_id, option_text, is_correct, position) VALUES (?, ?, ?, ?)').run(q1.lastInsertRowid, 'Gloves and safety glasses', 1, 0);
    await db.prepare('INSERT INTO training_quiz_options (question_id, option_text, is_correct, position) VALUES (?, ?, ?, ?)').run(q1.lastInsertRowid, 'No protection needed', 0, 1);
    await db.prepare('INSERT INTO training_assignments (training_id, member_id) VALUES (?, ?)').run(trainingId, studentId);
    void l1;
  }

  if (!(await db.prepare('SELECT 1 FROM forum_categories LIMIT 1').get())) {
    const cat = await db.prepare('INSERT INTO forum_categories (name, description, position) VALUES (?, ?, 0)').run('General Discussion', 'Ask questions, share tips.');
    const thread = await db.prepare('INSERT INTO forum_threads (category_id, title, member_id) VALUES (?, ?, ?)').run(cat.lastInsertRowid, 'Welcome to the HVAC Training chat!', instructorId);
    await db.prepare('INSERT INTO forum_posts (thread_id, member_id, body) VALUES (?, ?, ?)').run(thread.lastInsertRowid, instructorId, 'Welcome everyone - use this space to ask questions between classes.');
  }

  if (!(await db.prepare('SELECT 1 FROM document_categories LIMIT 1').get())) {
    const cat = await db.prepare('INSERT INTO document_categories (name, position) VALUES (?, 0)').run('Safety Data Sheets');
    void cat;
  }

  if (!(await db.prepare('SELECT 1 FROM member_directory_field_settings LIMIT 1').get())) {
    for (const key of ['photo', 'email', 'phone']) {
      await db.prepare('INSERT INTO member_directory_field_settings (field_key, visible) VALUES (?, 1)').run(key);
    }
  }

  console.log(`Seed complete. Login with admin@hvactraining.test / instructor@hvactraining.test / student@hvactraining.test, password: ${process.env.SEED_PASSWORD ? '(SEED_PASSWORD)' : PASSWORD}`);
}

module.exports = main;

if (require.main === module) {
  main()
    .then(() => db.close())
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
