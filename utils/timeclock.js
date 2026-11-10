// Time clock: clock in/out (optionally against a job), breaks, optional
// GPS stamp at clock events only (never continuous tracking), weekly
// overtime, manager approval, and employee correction requests.
// Approved entries are locked: employees can only request a correction.
const db = require('../db');
const fmt = require('./format');
const settings = require('./settings');

function coord(v, max) {
  const n = fmt.toNumber(v);
  return n !== null && Math.abs(n) <= max ? Math.round(n * 1e6) / 1e6 : null;
}

async function openEntry(memberId, tx = db) {
  return tx.prepare("SELECT te.*, j.job_number, j.title AS \"jobTitle\" FROM time_entries te LEFT JOIN jobs j ON j.id = te.job_id WHERE te.member_id = ? AND te.status = 'open' ORDER BY te.id DESC LIMIT 1").get(memberId);
}

async function openBreak(entryId, tx = db) {
  return tx.prepare('SELECT * FROM time_breaks WHERE entry_id = ? AND ended_at IS NULL').get(entryId);
}

async function clockIn(memberId, { jobId = null, lat, lng, notes = null }) {
  const gps = await settings.getBool('gps_clock_enabled');
  return db.withTransaction(async (tx) => {
    if (await openEntry(memberId, tx)) throw new Error('You are already clocked in.');
    const info = await tx
      .prepare("INSERT INTO time_entries (member_id, job_id, clock_in, in_lat, in_lng, notes, status) VALUES (?, ?, ?, ?, ?, ?, 'open')")
      .run(memberId, jobId || null, fmt.nowText(), gps ? coord(lat, 90) : null, gps ? coord(lng, 180) : null, fmt.clean(notes, 1000));
    return info.lastInsertRowid;
  });
}

async function clockOut(memberId, { lat, lng, notes = null }) {
  const gps = await settings.getBool('gps_clock_enabled');
  return db.withTransaction(async (tx) => {
    const entry = await openEntry(memberId, tx);
    if (!entry) throw new Error('You are not clocked in.');
    const now = fmt.nowText();
    await tx.prepare('UPDATE time_breaks SET ended_at = ? WHERE entry_id = ? AND ended_at IS NULL').run(now, entry.id);
    await tx
      .prepare("UPDATE time_entries SET clock_out = ?, out_lat = ?, out_lng = ?, notes = COALESCE(?, notes), status = 'pending' WHERE id = ?")
      .run(now, gps ? coord(lat, 90) : null, gps ? coord(lng, 180) : null, fmt.clean(notes, 1000), entry.id);
    return entry.id;
  });
}

async function startBreak(memberId) {
  return db.withTransaction(async (tx) => {
    const entry = await openEntry(memberId, tx);
    if (!entry) throw new Error('Clock in before starting a break.');
    if (await openBreak(entry.id, tx)) throw new Error('You are already on a break.');
    await tx.prepare('INSERT INTO time_breaks (entry_id, started_at) VALUES (?, ?)').run(entry.id, fmt.nowText());
  });
}

async function endBreak(memberId) {
  return db.withTransaction(async (tx) => {
    const entry = await openEntry(memberId, tx);
    const brk = entry && (await openBreak(entry.id, tx));
    if (!brk) throw new Error('You are not on a break.');
    await tx.prepare('UPDATE time_breaks SET ended_at = ? WHERE id = ?').run(fmt.nowText(), brk.id);
  });
}

// Entries (with worked/break minutes) whose clock_in falls in [from, to).
async function entries({ memberId = null, from, to, status = null }) {
  const where = ['te.clock_in >= ?', 'te.clock_in < ?'];
  const params = [from, to];
  if (memberId) { where.push('te.member_id = ?'); params.push(memberId); }
  if (status) { where.push('te.status = ?'); params.push(status); }
  const rows = await db
    .prepare(`SELECT te.*, m.name AS "memberName", j.job_number FROM time_entries te JOIN members m ON m.id = te.member_id LEFT JOIN jobs j ON j.id = te.job_id WHERE ${where.join(' AND ')} ORDER BY te.clock_in`)
    .all(...params);
  if (!rows.length) return rows;
  const breaks = await db.prepare(`SELECT * FROM time_breaks WHERE entry_id IN (${rows.map(() => '?').join(', ')})`).all(...rows.map((r) => r.id));
  const now = fmt.nowText();
  return rows.map((r) => {
    const end = r.clock_out || now;
    const breakMinutes = breaks.filter((b) => b.entry_id === r.id).reduce((s, b) => s + fmt.minutesBetween(b.started_at, b.ended_at || end), 0);
    return { ...r, breakMinutes, workedMinutes: Math.max(0, fmt.minutesBetween(r.clock_in, end) - breakMinutes) };
  });
}

// Weekly totals with overtime above the configured weekly threshold
// (default 40h). Daily-overtime rules (e.g. California) are not applied;
// see docs - overtime rules must be confirmed for the jurisdiction.
async function weekSummary(memberId, anyDateInWeek) {
  const start = fmt.weekStart(anyDateInWeek);
  const end = fmt.addDays(start, 7);
  const list = await entries({ memberId, from: start + ' 00:00:00', to: end + ' 00:00:00' });
  const threshold = (await settings.getInt('overtime_weekly_hours', 40)) * 60;
  const total = list.filter((e) => e.status !== 'rejected').reduce((s, e) => s + e.workedMinutes, 0);
  const days = {};
  for (const e of list) days[e.clock_in.slice(0, 10)] = (days[e.clock_in.slice(0, 10)] || 0) + (e.status === 'rejected' ? 0 : e.workedMinutes);
  return { start, end, entries: list, days, totalMinutes: total, regularMinutes: Math.min(total, threshold), overtimeMinutes: Math.max(0, total - threshold) };
}

async function decide(entryIds, status, managerId) {
  if (!['approved', 'rejected'].includes(status)) throw new Error('Invalid decision.');
  let n = 0;
  for (const id of entryIds) {
    const r = await db.prepare("UPDATE time_entries SET status = ?, approved_by = ?, approved_at = now_text() WHERE id = ? AND status = 'pending' AND member_id <> ?").run(status, managerId, id, managerId);
    n += r.changes || 0;
  }
  return n;
}

async function requestCorrection(memberId, entryId, { clockIn, clockOut, reason }) {
  const entry = await db.prepare('SELECT * FROM time_entries WHERE id = ? AND member_id = ?').get(entryId, memberId);
  if (!entry) throw new Error('Time entry not found.');
  if (!fmt.clean(reason)) throw new Error('Explain what needs to be corrected.');
  const inTs = fmt.fromLocalInput(clockIn);
  const outTs = fmt.fromLocalInput(clockOut);
  if (inTs && outTs && outTs <= inTs) throw new Error('Clock-out must be after clock-in.');
  await db.prepare('INSERT INTO time_corrections (entry_id, member_id, requested_clock_in, requested_clock_out, reason) VALUES (?, ?, ?, ?, ?)').run(entryId, memberId, inTs, outTs, fmt.clean(reason, 1000));
}

async function pendingCorrections() {
  return db
    .prepare(`SELECT tc.*, m.name AS "memberName", te.clock_in, te.clock_out FROM time_corrections tc JOIN members m ON m.id = tc.member_id JOIN time_entries te ON te.id = tc.entry_id WHERE tc.status = 'pending' ORDER BY tc.id`)
    .all();
}

async function decideCorrection(id, approve, managerId) {
  return db.withTransaction(async (tx) => {
    const c = await tx.prepare("SELECT * FROM time_corrections WHERE id = ? AND status = 'pending'").get(id);
    if (!c) throw new Error('Correction not found or already decided.');
    if (c.member_id === managerId) throw new Error("You can't approve your own correction.");
    if (approve) {
      const e = await tx.prepare('SELECT * FROM time_entries WHERE id = ?').get(c.entry_id);
      const newIn = c.requested_clock_in || e.clock_in;
      const newOut = c.requested_clock_out || e.clock_out;
      if (newOut && newOut <= newIn) throw new Error('Corrected clock-out would be before clock-in.');
      await tx
        .prepare('UPDATE time_entries SET clock_in = ?, clock_out = ?, status = ?, approved_by = ?, approved_at = now_text() WHERE id = ?')
        .run(newIn, newOut, newOut ? 'approved' : e.status, managerId, c.entry_id);
    }
    await tx.prepare('UPDATE time_corrections SET status = ?, decided_by = ?, decided_at = now_text() WHERE id = ?').run(approve ? 'approved' : 'rejected', managerId, id);
    return c;
  });
}

module.exports = { openEntry, openBreak, clockIn, clockOut, startBreak, endBreak, entries, weekSummary, decide, requestCorrection, pendingCorrections, decideCorrection };
