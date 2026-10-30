// Training & Learning module - Trainings -> Lessons (video/text/quiz) ->
// Assignments (one per member per training) -> Attempts (one per
// retake). Trimmed from the reference app's version: no allow-skipping
// override (sequential_lessons alone decides locking), no video-percent
// threshold (a video counts complete once the player reports 'ended'),
// and a failed attempt always becomes retry_required rather than a
// separate terminal 'failed' status - a training assigned to someone
// should always be retakeable here, there's no "permanently failed"
// case this portal needs.
const db = require('../db');

async function listTrainings() {
  return db
    .prepare(
      `SELECT t.*,
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.training_id = t.id) AS "lessonCount",
        (SELECT COUNT(*) FROM training_assignments ta WHERE ta.training_id = t.id) AS "assignmentCount"
       FROM trainings t ORDER BY t.created_at DESC`
    )
    .all();
}

async function getTraining(id) {
  return db.prepare('SELECT * FROM trainings WHERE id = ?').get(id);
}

async function getTrainingWithContent(id) {
  const training = await getTraining(id);
  if (!training) return null;
  const lessons = await db.prepare('SELECT * FROM training_lessons WHERE training_id = ? ORDER BY position, id').all(id);
  for (const lesson of lessons) {
    if (lesson.type === 'quiz') {
      const questions = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lesson.id);
      for (const q of questions) {
        q.options = await db.prepare('SELECT * FROM training_quiz_options WHERE question_id = ? ORDER BY position, id').all(q.id);
      }
      lesson.questions = questions;
    }
  }
  training.lessons = lessons;
  return training;
}

async function createTraining(data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Title is required.');
  const info = await db
    .prepare('INSERT INTO trainings (title, description, estimated_minutes, passing_score, sequential_lessons, require_video_completion) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, (data.description || '').trim() || null, parseInt(data.estimatedMinutes, 10) || null, Math.max(0, Math.min(100, parseInt(data.passingScore, 10) || 80)), data.sequentialLessons ? 1 : 0, data.requireVideoCompletion ? 1 : 0);
  return info.lastInsertRowid;
}

async function updateTraining(id, data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Title is required.');
  await db
    .prepare('UPDATE trainings SET title = ?, description = ?, estimated_minutes = ?, passing_score = ?, sequential_lessons = ?, require_video_completion = ?, updated_at = now_text() WHERE id = ?')
    .run(title, (data.description || '').trim() || null, parseInt(data.estimatedMinutes, 10) || null, Math.max(0, Math.min(100, parseInt(data.passingScore, 10) || 80)), data.sequentialLessons ? 1 : 0, data.requireVideoCompletion ? 1 : 0, id);
}

async function setTrainingStatus(id, status) {
  if (!['draft', 'published', 'archived'].includes(status)) throw new Error('Invalid status.');
  if (status === 'published') {
    const row = await db.prepare('SELECT COUNT(*) AS n FROM training_lessons WHERE training_id = ?').get(id);
    if (!row || row.n === 0) throw new Error('Add at least one lesson before publishing.');
  }
  await db.prepare('UPDATE trainings SET status = ?, updated_at = now_text() WHERE id = ?').run(status, id);
}

async function deleteTraining(id) {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM training_assignments WHERE training_id = ?').get(id);
  if (row && row.n > 0) return false;
  await db.prepare('DELETE FROM trainings WHERE id = ?').run(id);
  return true;
}

// --- Lessons ---

async function createLesson(trainingId, data) {
  const title = (data.title || '').trim();
  if (!title) throw new Error('Lesson title is required.');
  const type = ['video', 'text', 'quiz'].includes(data.type) ? data.type : 'text';
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM training_lessons WHERE training_id = ?').get(trainingId);
  const position = (row && row.maxPos != null ? row.maxPos : -1) + 1;
  const info = await db
    .prepare('INSERT INTO training_lessons (training_id, title, description, type, position, required, video_url, content) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(trainingId, title, (data.description || '').trim() || null, type, position, data.required === false ? 0 : 1, (data.videoUrl || '').trim() || null, (data.content || '').trim() || null);
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(trainingId);
  return info.lastInsertRowid;
}

async function deleteLesson(lessonId) {
  const lesson = await db.prepare('SELECT training_id FROM training_lessons WHERE id = ?').get(lessonId);
  if (!lesson) return;
  await db.prepare('DELETE FROM training_lessons WHERE id = ?').run(lessonId);
  await db.prepare('UPDATE trainings SET updated_at = now_text() WHERE id = ?').run(lesson.training_id);
}

// data.options: [{ text, correct }, ...]
async function createQuizQuestion(lessonId, data) {
  const question = (data.question || '').trim();
  if (!question) throw new Error('Question text is required.');
  const options = (data.options || []).map((o) => ({ text: (o.text || '').trim(), correct: !!o.correct })).filter((o) => o.text);
  if (options.length < 2) throw new Error('At least two answer options are required.');
  if (!options.some((o) => o.correct)) throw new Error('One option must be marked correct.');
  const row = await db.prepare('SELECT MAX(position) AS "maxPos" FROM training_quiz_questions WHERE lesson_id = ?').get(lessonId);
  const position = (row && row.maxPos != null ? row.maxPos : -1) + 1;
  const points = Math.max(1, parseInt(data.points, 10) || 1);

  return db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO training_quiz_questions (lesson_id, question, points, position) VALUES (?, ?, ?, ?)').run(lessonId, question, points, position);
    const questionId = info.lastInsertRowid;
    let i = 0;
    for (const o of options) {
      await tx.prepare('INSERT INTO training_quiz_options (question_id, option_text, is_correct, position) VALUES (?, ?, ?, ?)').run(questionId, o.text, o.correct ? 1 : 0, i++);
    }
    return questionId;
  });
}

async function deleteQuizQuestion(questionId) {
  await db.prepare('DELETE FROM training_quiz_questions WHERE id = ?').run(questionId);
}

// --- Assignment (admin side) ---

async function assignableMembers() {
  return db.prepare("SELECT id, name, role FROM members WHERE active = 1 ORDER BY name").all();
}

async function assignTrainingToMembers(trainingId, memberIds, dueAt) {
  let assigned = 0;
  for (const memberId of memberIds) {
    const info = await db
      .prepare('INSERT INTO training_assignments (training_id, member_id, due_at) VALUES (?, ?, ?) ON CONFLICT (training_id, member_id) DO NOTHING')
      .run(trainingId, memberId, dueAt || null);
    if (info.changes > 0) assigned++;
  }
  return assigned;
}

async function removeAssignment(assignmentId) {
  await db.prepare('DELETE FROM training_assignments WHERE id = ?').run(assignmentId);
}

async function assignmentsForTraining(trainingId) {
  return db
    .prepare(`SELECT ta.*, m.name AS "memberName", m.role AS "memberRole" FROM training_assignments ta JOIN members m ON m.id = ta.member_id WHERE ta.training_id = ? ORDER BY m.name`)
    .all(trainingId);
}

// --- Member-facing: Training Player ---

async function myAssignments(memberId) {
  return db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.estimated_minutes AS "estimatedMinutes", t.status AS "trainingStatus",
        (SELECT COUNT(*) FROM training_lessons tl WHERE tl.training_id = t.id) AS "lessonCount"
       FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id
       WHERE ta.member_id = ? AND t.status = 'published'
       ORDER BY (ta.status = 'in_progress') DESC, (ta.status = 'retry_required') DESC, ta.assigned_at DESC`
    )
    .all(memberId);
}

// The one server-side ownership check every member-facing training route
// relies on - an assignment id alone is never enough, it must belong to
// the signed-in member too.
async function getAssignmentForMember(assignmentId, memberId) {
  return db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.status AS "trainingStatus", t.sequential_lessons AS "sequentialLessons",
        t.require_video_completion AS "requireVideoCompletion", t.passing_score AS "passingScore"
       FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id
       WHERE ta.id = ? AND ta.member_id = ?`
    )
    .get(assignmentId, memberId);
}

async function startAttempt(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  const training = await db.prepare('SELECT * FROM trainings WHERE id = ?').get(assignment.training_id);
  const lessons = await db.prepare('SELECT * FROM training_lessons WHERE training_id = ? ORDER BY position, id').all(training.id);
  const attemptNumber = assignment.attempt_count + 1;

  return db.withTransaction(async (tx) => {
    const info = await tx.prepare('INSERT INTO training_attempts (assignment_id, attempt_number, passing_score_snapshot) VALUES (?, ?, ?)').run(assignmentId, attemptNumber, training.passing_score);
    const attemptId = info.lastInsertRowid;
    let firstLessonId = null;
    for (let i = 0; i < lessons.length; i++) {
      const lesson = lessons[i];
      const status = training.sequential_lessons !== 1 || i === 0 ? 'available' : 'locked';
      if (!firstLessonId) firstLessonId = lesson.id;
      await tx
        .prepare('INSERT INTO training_lesson_progress (attempt_id, lesson_id, lesson_title_snapshot, lesson_type_snapshot, lesson_position_snapshot, lesson_required_snapshot, status) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(attemptId, lesson.id, lesson.title, lesson.type, lesson.position, lesson.required, status);
    }
    await tx.prepare(`UPDATE training_assignments SET status = 'in_progress', attempt_count = ?, current_lesson_id = ? WHERE id = ?`).run(attemptNumber, firstLessonId, assignmentId);
    return attemptId;
  });
}

async function ensureAttemptStarted(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  if (!assignment) return null;
  if (assignment.status === 'not_started') await startAttempt(assignmentId);
  return db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
}

async function startRetake(assignmentId) {
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(assignmentId);
  if (!assignment || assignment.status !== 'retry_required') throw new Error('This training is not eligible for a retake right now.');
  return startAttempt(assignmentId);
}

// A training with zero required lessons falls back to counting every
// lesson - see the reference app's own bug report on `.every()` over an
// empty array being vacuously true otherwise.
function completionGatingLessons(lessons) {
  const required = lessons.filter((l) => l.lesson_required_snapshot === 1);
  return required.length ? required : lessons;
}

async function getPlayerState(assignmentId) {
  const assignment = await db
    .prepare(
      `SELECT ta.*, t.title, t.description, t.estimated_minutes AS "estimatedMinutes", t.sequential_lessons AS "sequentialLessons",
        t.passing_score AS "passingScore", t.require_video_completion AS "requireVideoCompletion"
       FROM training_assignments ta JOIN trainings t ON t.id = ta.training_id WHERE ta.id = ?`
    )
    .get(assignmentId);
  if (!assignment) return null;
  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
  if (!attempt) return { assignment, attempt: null, lessons: [], percentComplete: 0 };
  const lessons = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? ORDER BY lesson_position_snapshot, id').all(attempt.id);
  const gating = completionGatingLessons(lessons);
  const completed = gating.filter((l) => l.status === 'completed');
  const percentComplete = gating.length ? Math.round((completed.length / gating.length) * 100) : 100;
  return { assignment, attempt, lessons, percentComplete };
}

async function startLesson(assignmentId, lessonId) {
  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
  if (!attempt) return null;
  const progress = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?').get(attempt.id, lessonId);
  if (!progress || progress.status === 'locked') return null;
  if (progress.status === 'available') {
    await db.prepare("UPDATE training_lesson_progress SET status = 'in_progress', started_at = now_text() WHERE id = ?").run(progress.id);
  }
  return progress;
}

async function markVideoWatched(assignmentId, lessonId) {
  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
  if (!attempt) return null;
  const progress = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?').get(attempt.id, lessonId);
  if (!progress || progress.status === 'locked' || progress.lesson_type_snapshot !== 'video') return null;
  await db.prepare("UPDATE training_lesson_progress SET video_completed = 1, status = CASE WHEN status = 'available' THEN 'in_progress' ELSE status END WHERE id = ?").run(progress.id);
  return { completed: true };
}

// Marks progress.id completed and unlocks the next locked lesson in
// position order.
async function advanceLesson(attemptId, progress, queryable = db) {
  await queryable.prepare("UPDATE training_lesson_progress SET status = 'completed', completed_at = now_text() WHERE id = ?").run(progress.id);
  const all = await queryable.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? ORDER BY lesson_position_snapshot, id').all(attemptId);
  const next = all.find((l) => l.status === 'locked');
  if (next) await queryable.prepare("UPDATE training_lesson_progress SET status = 'available' WHERE id = ?").run(next.id);
  const assignmentId = (await queryable.prepare('SELECT assignment_id FROM training_attempts WHERE id = ?').get(attemptId)).assignment_id;
  await queryable.prepare('UPDATE training_assignments SET current_lesson_id = ? WHERE id = ?').run(next ? next.lesson_id : null, assignmentId);
}

async function completeLesson(assignmentId, lessonId) {
  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
  if (!attempt) throw new Error('No active attempt.');
  const progress = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?').get(attempt.id, lessonId);
  if (!progress) throw new Error('Lesson not found on this attempt.');
  if (progress.status === 'locked') throw new Error('This lesson is locked.');
  if (progress.status === 'completed') return maybeFinalizeAttempt(attempt.id);
  if (progress.lesson_type_snapshot === 'quiz') throw new Error('Submit the quiz to complete this lesson.');

  if (progress.lesson_type_snapshot === 'video') {
    const training = await db
      .prepare('SELECT t.require_video_completion AS "requireVideoCompletion" FROM training_attempts ta JOIN training_assignments a ON a.id = ta.assignment_id JOIN trainings t ON t.id = a.training_id WHERE ta.id = ?')
      .get(attempt.id);
    if (training.requireVideoCompletion === 1 && progress.lesson_required_snapshot === 1 && progress.video_completed !== 1) {
      throw new Error('Watch the required video before continuing.');
    }
  }
  await advanceLesson(attempt.id, progress);
  return maybeFinalizeAttempt(attempt.id);
}

// answers: { [questionId]: selectedOptionId } - untrusted input, always
// re-graded against the live is_correct flag rather than trusting the
// client.
async function submitQuiz(assignmentId, lessonId, answers) {
  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE assignment_id = ? ORDER BY attempt_number DESC LIMIT 1').get(assignmentId);
  if (!attempt) throw new Error('No active attempt.');
  const progress = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ? AND lesson_id = ?').get(attempt.id, lessonId);
  if (!progress) throw new Error('Lesson not found on this attempt.');
  if (progress.status === 'locked') throw new Error('This lesson is locked.');
  if (progress.lesson_type_snapshot !== 'quiz') throw new Error('This lesson is not a quiz.');
  if (progress.status === 'completed') throw new Error('This quiz has already been submitted.');

  const questions = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lessonId);

  await db.withTransaction(async (tx) => {
    for (const q of questions) {
      const submittedOptionId = answers && Object.prototype.hasOwnProperty.call(answers, String(q.id)) ? parseInt(answers[String(q.id)], 10) : null;
      let selectedOption = null;
      if (submittedOptionId) selectedOption = await tx.prepare('SELECT * FROM training_quiz_options WHERE id = ? AND question_id = ?').get(submittedOptionId, q.id);
      const isCorrect = !!(selectedOption && selectedOption.is_correct === 1);
      await tx
        .prepare(
          `INSERT INTO training_quiz_answers (attempt_id, question_id, question_text_snapshot, points_possible_snapshot, selected_option_id, selected_option_text_snapshot, is_correct, points_earned)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (attempt_id, question_id) DO UPDATE SET selected_option_id = excluded.selected_option_id, selected_option_text_snapshot = excluded.selected_option_text_snapshot, is_correct = excluded.is_correct, points_earned = excluded.points_earned`
        )
        .run(attempt.id, q.id, q.question, q.points, selectedOption ? selectedOption.id : null, selectedOption ? selectedOption.option_text : null, isCorrect ? 1 : 0, isCorrect ? q.points : 0);
    }
    await advanceLesson(attempt.id, progress, tx);
  });

  return maybeFinalizeAttempt(attempt.id);
}

async function maybeFinalizeAttempt(attemptId) {
  const lessons = await db.prepare('SELECT * FROM training_lesson_progress WHERE attempt_id = ?').all(attemptId);
  const requiredDone = completionGatingLessons(lessons).every((l) => l.status === 'completed');
  if (!requiredDone) return { finalized: false };

  const attempt = await db.prepare('SELECT * FROM training_attempts WHERE id = ?').get(attemptId);
  if (attempt.completed_at) return { finalized: true, alreadyDone: true, score: attempt.score, passed: attempt.passed === 1 };

  const answers = await db.prepare('SELECT * FROM training_quiz_answers WHERE attempt_id = ?').all(attemptId);
  const possible = answers.reduce((sum, a) => sum + a.points_possible_snapshot, 0);
  const earned = answers.reduce((sum, a) => sum + a.points_earned, 0);
  const score = possible > 0 ? Math.round((earned / possible) * 100) : 100;
  const passed = score >= attempt.passing_score_snapshot;
  const assignment = await db.prepare('SELECT * FROM training_assignments WHERE id = ?').get(attempt.assignment_id);

  await db.withTransaction(async (tx) => {
    await tx.prepare('UPDATE training_attempts SET completed_at = now_text(), score = ?, passed = ? WHERE id = ?').run(score, passed ? 1 : 0, attemptId);
    const bestScore = assignment.best_score == null ? score : Math.max(assignment.best_score, score);
    await tx
      .prepare(`UPDATE training_assignments SET status = ?, latest_score = ?, best_score = ?, completed_at = CASE WHEN ? = 1 THEN now_text() ELSE completed_at END WHERE id = ?`)
      .run(passed ? 'passed' : 'retry_required', score, bestScore, passed ? 1 : 0, assignment.id);
  });

  return { finalized: true, score, passed };
}

module.exports = {
  listTrainings,
  getTraining,
  getTrainingWithContent,
  createTraining,
  updateTraining,
  setTrainingStatus,
  deleteTraining,
  createLesson,
  deleteLesson,
  createQuizQuestion,
  deleteQuizQuestion,
  assignableMembers,
  assignTrainingToMembers,
  removeAssignment,
  assignmentsForTraining,
  myAssignments,
  getAssignmentForMember,
  ensureAttemptStarted,
  startRetake,
  getPlayerState,
  startLesson,
  markVideoWatched,
  completeLesson,
  submitQuiz,
};
