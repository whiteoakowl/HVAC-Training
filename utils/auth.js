// Member account auth - a single member_accounts-style table (`members`
// itself, since this portal doesn't separate "profile" from "login" the
// way the reference app's admin-managed roster does) with one role per
// account: student, instructor, or admin. Simpler than the reference
// app's many-to-many roles/permissions system since no member here needs
// to hold more than one portal at once.
const bcrypt = require('bcryptjs');
const db = require('../db');

const ROLES = ['student', 'instructor', 'admin'];

async function findByEmail(email) {
  return db.prepare('SELECT * FROM members WHERE LOWER(email) = LOWER(?)').get((email || '').trim());
}

async function findById(id) {
  return db.prepare('SELECT * FROM members WHERE id = ?').get(id);
}

async function verifyPassword(member, password) {
  return bcrypt.compareSync(password || '', member.password_hash);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

async function createMember({ name, email, password, role }) {
  const info = await db
    .prepare('INSERT INTO members (name, email, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(name, email.trim().toLowerCase(), hashPassword(password), ROLES.includes(role) ? role : 'student');
  return info.lastInsertRowid;
}

module.exports = { ROLES, findByEmail, findById, verifyPassword, hashPassword, createMember };
