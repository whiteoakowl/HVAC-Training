// Meetings: who can see a meeting, who gets notified, the video link,
// and the month calendar grid. Times are company-local wall-clock text
// ("YYYY-MM-DD HH:MM:SS"), like the rest of the app.
const crypto = require('crypto');
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');
const permissions = require('./permissions');

const DURATIONS = [15, 30, 45, 60, 90, 120, 180, 240];
const JOIN_EARLY_MINUTES = 15;

function newRoomKey() {
  return crypto.randomBytes(12).toString('hex');
}

// Only plain https:// links are accepted for outside video services
// (Zoom, Google Meet, Microsoft Teams, ...).
function cleanLink(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(s);
  } catch (e) {
    return null;
  }
  return u.protocol === 'https:' && u.hostname ? u.href : null;
}

function validDomain(v) {
  return /^(?=.{3,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i.test(String(v || ''));
}

async function videoDomain() {
  const d = String(await settings.get('meeting_video_domain', 'meet.jit.si')).trim().toLowerCase();
  return validDomain(d) ? d : 'meet.jit.si';
}

// The built-in room is a Jitsi Meet room with an unguessable name.
async function videoUrl(m) {
  if (m.video_kind === 'link') return m.video_url || null;
  if (m.video_kind === 'none') return null;
  return `https://${await videoDomain()}/HVAC-${m.room_key}`;
}

function endsAt(m) {
  return fmt.addMinutes(m.starts_at, m.duration_minutes);
}

// 'upcoming' | 'soon' (join window open) | 'live' | 'ended' | 'cancelled'
function phase(m, now = fmt.nowText()) {
  if (m.status === 'cancelled') return 'cancelled';
  const end = endsAt(m);
  if (now >= end) return 'ended';
  if (now >= m.starts_at) return 'live';
  if (now >= fmt.addMinutes(m.starts_at, -JOIN_EARLY_MINUTES)) return 'soon';
  return 'upcoming';
}

// SQL condition: meetings this member can see. Managers see all.
function visibleWhere(req) {
  if (req.can('meetings.manage')) return { sql: '1 = 1', args: [] };
  return {
    sql: "(m.audience = 'all' OR (m.audience = 'role' AND m.audience_role = ?) OR m.created_by = ? OR EXISTS (SELECT 1 FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.member_id = ?))",
    args: [req.member.role, req.member.id, req.member.id],
  };
}

const SELECT = 'SELECT m.*, c.name AS "createdByName", r.name AS "roleName" FROM meetings m LEFT JOIN members c ON c.id = m.created_by LEFT JOIN roles r ON r.key = m.audience_role';

async function list(req, { from, to, includeCancelled = true } = {}) {
  const w = visibleWhere(req);
  const where = [w.sql];
  const args = [...w.args];
  if (from) { where.push('m.starts_at >= ?'); args.push(from); }
  if (to) { where.push('m.starts_at < ?'); args.push(to); }
  if (!includeCancelled) where.push("m.status = 'scheduled'");
  return db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY m.starts_at, m.id`).all(...args);
}

async function find(req, id) {
  const w = visibleWhere(req);
  return db.prepare(`${SELECT} WHERE m.id = ? AND ${w.sql}`).get(id, ...w.args);
}

async function attendees(meetingId) {
  return db.prepare('SELECT mb.id, mb.name FROM meeting_attendees a JOIN members mb ON mb.id = a.member_id WHERE a.meeting_id = ? ORDER BY mb.name').all(meetingId);
}

// Active staff who can be invited (anyone who can see meetings).
async function staff() {
  return permissions.membersWith('meetings.view', 'meetings.manage');
}

// Everyone invited to a meeting (for notifications).
async function invitees(m) {
  if (m.audience === 'people') return (await attendees(m.id)).map((a) => a.id);
  const all = await staff();
  return all.filter((s) => m.audience === 'all' || s.role === m.audience_role).map((s) => s.id);
}

async function audienceLabel(m) {
  if (m.audience === 'all') return 'All staff';
  if (m.audience === 'role') return (m.roleName || m.audience_role || 'One role') + ' only';
  const a = await attendees(m.id);
  return a.length ? a.map((x) => x.name).join(', ') : 'No one invited yet';
}

// Month grid starting on Sunday (US calendar). month = "YYYY-MM".
function monthGrid(month, meetings) {
  const first = `${month}-01`;
  const firstDow = new Date(first + 'T00:00:00Z').getUTCDay();
  const start = fmt.addDays(first, -firstDow);
  const next = nextMonth(month);
  const weeks = [];
  let day = start;
  do {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: day, inMonth: day.slice(0, 7) === month, meetings: meetings.filter((m) => m.starts_at.slice(0, 10) === day) });
      day = fmt.addDays(day, 1);
    }
    weeks.push(week);
  } while (day < `${next}-01`);
  return weeks;
}

function nextMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
function prevMonth(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
function monthName(month) {
  const [y, m] = month.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

module.exports = {
  DURATIONS, JOIN_EARLY_MINUTES, newRoomKey, cleanLink, validDomain, videoDomain, videoUrl, endsAt, phase,
  list, find, attendees, staff, invitees, audienceLabel, monthGrid, nextMonth, prevMonth, monthName,
};
