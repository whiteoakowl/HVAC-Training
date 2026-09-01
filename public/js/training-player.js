// Reports real video completion (the 'ended' event) to the server, and
// marks the current lesson in-progress as soon as its panel loads. The
// server is the only thing that decides whether a required video gates
// the Complete button (utils/training.js's completeLesson) - this script
// just reports honestly what the player observed.
(function () {
  const video = document.getElementById('training-video');
  if (video) {
    const aId = video.dataset.assignmentId;
    const lId = video.dataset.lessonId;
    video.addEventListener('ended', () => {
      fetch(`/training/${aId}/lessons/${lId}/video-watched`, { method: 'POST' })
        .then((r) => r.json())
        .then((data) => {
          if (!data.ok) return;
          const status = document.getElementById('training-video-status');
          if (status) status.textContent = 'Watched';
          const completeBtn = document.getElementById('training-complete-btn');
          if (completeBtn) {
            completeBtn.disabled = false;
            completeBtn.textContent = 'Mark Complete & Continue';
          }
        })
        .catch(() => {});
    });
  }

  const completeForm = document.querySelector('form[action$="/complete"]');
  const quizForm = document.querySelector('form[action$="/quiz"]');
  const actionUrl = completeForm ? completeForm.getAttribute('action') : quizForm ? quizForm.getAttribute('action') : video ? `/training/${video.dataset.assignmentId}/lessons/${video.dataset.lessonId}/start` : null;
  const match = actionUrl && /\/training\/(\d+)\/lessons\/(\d+)\//.exec(actionUrl);
  if (match) fetch(`/training/${match[1]}/lessons/${match[2]}/start`, { method: 'POST' }).catch(() => {});
})();
