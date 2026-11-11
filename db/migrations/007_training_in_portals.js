// Training is no longer a separate portal. Employees take their courses
// from the Training tab of the employee portal; managers build courses,
// assign them and track completion from the management side.
//  * Trainees and Training Instructors get the employee portal, so they
//    land there instead of on the old standalone training home.
//  * Office Managers can manage training (General Managers and Service
//    Managers already could).
// Only adds permissions; nothing is removed and no data changes.
const GRANTS = [
  ['student', 'portal.employee'],
  ['instructor', 'portal.employee'],
  ['office_manager', 'training.manage'],
];

module.exports = {
  id: '007_training_in_portals',
  sql: GRANTS.map(([role, perm]) =>
    `INSERT INTO role_permissions (role_key, permission_key) SELECT '${role}', '${perm}' WHERE EXISTS (SELECT 1 FROM roles WHERE key = '${role}') AND EXISTS (SELECT 1 FROM permissions WHERE key = '${perm}') ON CONFLICT DO NOTHING;`
  ).join('\n') + `
UPDATE roles SET description = 'Employee in training: takes assigned courses from the Training tab of the employee portal.' WHERE key = 'student' AND description = 'Original portal role: takes training, events, chat and documents.';
UPDATE roles SET description = 'Builds courses, assigns training and tracks completion; also manages events and documents.' WHERE key = 'instructor' AND description = 'Original portal role: builds training, events and documents.';
`,
};
