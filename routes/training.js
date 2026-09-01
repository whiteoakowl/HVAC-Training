const express = require('express');
const router = express.Router();
const { requireAuth, requireRole } = require('../middleware/auth');
const T = require('../utils/training');
const notifications = require('../utils/notifications');

router.use(requireAuth);

// --- Member-facing player ---

router.get('/training/mine', async (req, res) => {
  res.render('training-mine', { title: 'My Training', assignments: await T.myAssignments(req.member.id) });
});

router.get('/training/:assignmentId/play', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment || assignment.trainingStatus !== 'published') return res.status(404).render('404', { title: 'Not Found' });

  await T.ensureAttemptStarted(assignment.id);
  const state = await T.getPlayerState(assignment.id);

  const requestedLessonId = parseInt(req.query.lesson, 10) || assignment.current_lesson_id;
  let selected = state.lessons.find((l) => l.lesson_id === requestedLessonId && l.status !== 'locked');
  if (!selected) selected = state.lessons.find((l) => l.status !== 'locked' && l.status !== 'completed') || state.lessons.find((l) => l.status !== 'locked');

  let questions = null;
  let lessonRow = null;
  const db = require('../db');
  if (selected && selected.lesson_id) {
    lessonRow = await db.prepare('SELECT * FROM training_lessons WHERE id = ?').get(selected.lesson_id);
    if (selected.lesson_type_snapshot === 'quiz' && lessonRow) {
      questions = await db.prepare('SELECT * FROM training_quiz_questions WHERE lesson_id = ? ORDER BY position, id').all(lessonRow.id);
      for (const q of questions) q.options = await db.prepare('SELECT id, option_text FROM training_quiz_options WHERE question_id = ? ORDER BY position, id').all(q.id);
    }
  }

  res.render('training-play', { title: state.assignment.title, state, selected, lessonRow, questions, error: req.query.error || null });
});

router.post('/training/:assignmentId/lessons/:lessonId/start', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment) return res.status(404).json({ ok: false });
  const progress = await T.startLesson(assignment.id, req.params.lessonId);
  res.json({ ok: !!progress });
});

router.post('/training/:assignmentId/lessons/:lessonId/video-watched', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment) return res.status(404).json({ ok: false });
  const result = await T.markVideoWatched(assignment.id, req.params.lessonId);
  res.json({ ok: !!result });
});

router.post('/training/:assignmentId/lessons/:lessonId/complete', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  try {
    const result = await T.completeLesson(assignment.id, req.params.lessonId);
    if (result && result.finalized && result.passed) {
      await notifications.notify(req.member.id, 'training_assigned', { title: `Passed: ${assignment.title}`, body: `Score: ${result.score}%`, linkUrl: `/training/${assignment.id}/play` });
    }
    res.redirect(`/training/${assignment.id}/play`);
  } catch (e) {
    res.redirect(`/training/${assignment.id}/play?lesson=${req.params.lessonId}&error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/:assignmentId/lessons/:lessonId/quiz', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  const answers = {};
  Object.keys(req.body).forEach((key) => {
    const m = /^answer_(\d+)$/.exec(key);
    if (m) answers[m[1]] = req.body[key];
  });
  try {
    await T.submitQuiz(assignment.id, req.params.lessonId, answers);
    res.redirect(`/training/${assignment.id}/play`);
  } catch (e) {
    res.redirect(`/training/${assignment.id}/play?lesson=${req.params.lessonId}&error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/:assignmentId/retake', async (req, res) => {
  const assignment = await T.getAssignmentForMember(req.params.assignmentId, req.member.id);
  if (!assignment) return res.status(404).render('404', { title: 'Not Found' });
  try {
    await T.startRetake(assignment.id);
  } catch (e) {
    return res.redirect('/training/mine?error=' + encodeURIComponent(e.message));
  }
  res.redirect(`/training/${assignment.id}/play`);
});

// --- Admin/instructor Training Builder ---

router.get('/training/manage', requireRole('instructor'), async (req, res) => {
  res.render('training-manage', { title: 'Manage Training', trainings: await T.listTrainings(), notice: req.query.notice || null });
});

router.get('/training/manage/new', requireRole('instructor'), (req, res) => {
  res.render('training-form', { title: 'New Training', training: null, error: req.query.error || null });
});

router.post('/training/manage/new', requireRole('instructor'), async (req, res) => {
  try {
    const id = await T.createTraining({
      title: req.body.title,
      description: req.body.description,
      estimatedMinutes: req.body.estimatedMinutes,
      passingScore: req.body.passingScore,
      sequentialLessons: req.body.sequentialLessons === '1',
      requireVideoCompletion: req.body.requireVideoCompletion === '1',
    });
    res.redirect(`/training/manage/${id}`);
  } catch (e) {
    res.redirect('/training/manage/new?error=' + encodeURIComponent(e.message));
  }
});

router.get('/training/manage/:id', requireRole('instructor'), async (req, res) => {
  const training = await T.getTrainingWithContent(req.params.id);
  if (!training) return res.status(404).render('404', { title: 'Not Found' });
  res.render('training-builder', {
    title: training.title,
    training,
    assignments: await T.assignmentsForTraining(training.id),
    members: await T.assignableMembers(),
    error: req.query.error || null,
    notice: req.query.notice || null,
  });
});

router.post('/training/manage/:id/edit', requireRole('instructor'), async (req, res) => {
  try {
    await T.updateTraining(req.params.id, {
      title: req.body.title,
      description: req.body.description,
      estimatedMinutes: req.body.estimatedMinutes,
      passingScore: req.body.passingScore,
      sequentialLessons: req.body.sequentialLessons === '1',
      requireVideoCompletion: req.body.requireVideoCompletion === '1',
    });
    res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Saved.'));
  } catch (e) {
    res.redirect(`/training/manage/${req.params.id}?error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/manage/:id/status', requireRole('instructor'), async (req, res) => {
  try {
    await T.setTrainingStatus(req.params.id, req.body.status);
    res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Status updated.'));
  } catch (e) {
    res.redirect(`/training/manage/${req.params.id}?error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/manage/:id/delete', requireRole('instructor'), async (req, res) => {
  const ok = await T.deleteTraining(req.params.id);
  res.redirect(ok ? '/training/manage' : `/training/manage/${req.params.id}?error=` + encodeURIComponent('Cannot delete a training that already has assignments - archive it instead.'));
});

router.post('/training/manage/:id/lessons', requireRole('instructor'), async (req, res) => {
  try {
    await T.createLesson(req.params.id, { title: req.body.title, description: req.body.description, type: req.body.type, required: req.body.required === '1', videoUrl: req.body.videoUrl, content: req.body.content });
    res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Lesson added.'));
  } catch (e) {
    res.redirect(`/training/manage/${req.params.id}?error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/manage/:id/lessons/:lessonId/delete', requireRole('instructor'), async (req, res) => {
  await T.deleteLesson(req.params.lessonId);
  res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Lesson removed.'));
});

router.post('/training/manage/:id/lessons/:lessonId/questions', requireRole('instructor'), async (req, res) => {
  const optionTexts = [].concat(req.body.optionText || []);
  const correctIndex = parseInt(req.body.correctIndex, 10);
  const options = optionTexts.map((text, i) => ({ text, correct: i === correctIndex }));
  try {
    await T.createQuizQuestion(req.params.lessonId, { question: req.body.question, points: req.body.points, options });
    res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Question added.'));
  } catch (e) {
    res.redirect(`/training/manage/${req.params.id}?error=` + encodeURIComponent(e.message));
  }
});

router.post('/training/manage/:id/lessons/:lessonId/questions/:questionId/delete', requireRole('instructor'), async (req, res) => {
  await T.deleteQuizQuestion(req.params.questionId);
  res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Question removed.'));
});

router.post('/training/manage/:id/assign', requireRole('instructor'), async (req, res) => {
  const memberIds = [].concat(req.body.memberIds || []).map((id) => parseInt(id, 10));
  const assigned = await T.assignTrainingToMembers(req.params.id, memberIds, req.body.dueAt || null);
  for (const memberId of memberIds) {
    await notifications.notify(memberId, 'training_assigned', { title: 'New Training Assigned', body: 'Check My Training to get started.', linkUrl: '/training/mine' });
  }
  res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent(`Assigned to ${assigned} member(s).`));
});

router.post('/training/manage/:id/assignments/:assignmentId/remove', requireRole('instructor'), async (req, res) => {
  await T.removeAssignment(req.params.assignmentId);
  res.redirect(`/training/manage/${req.params.id}?notice=` + encodeURIComponent('Assignment removed.'));
});

module.exports = router;
