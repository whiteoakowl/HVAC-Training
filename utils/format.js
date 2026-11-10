// Shared formatting / parsing helpers (exposed to every view as `fmt`).
//
// Timestamps are stored as 'YYYY-MM-DD HH:MM:SS' wall-clock text in the
// company's timezone (Company Settings -> timezone, or APP_TIMEZONE),
// so schedules typed by the office and clock punches line up.

let TZ = process.env.APP_TIMEZONE || 'UTC';
const fmtCache = new Map();

function validTimezone(tz) {
  if (!tz || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch (e) {
    return false;
  }
}

function setTimezone(tz) {
  if (validTimezone(tz)) TZ = tz;
  return TZ;
}

function timezone() {
  return TZ;
}

function parts(date) {
  if (!fmtCache.has(TZ)) {
    fmtCache.set(TZ, new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }));
  }
  const p = Object.fromEntries(fmtCache.get(TZ).formatToParts(date).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function money(cents) {
  const n = Math.round(Number(cents || 0));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

// "1,234.5" / "$12" / "12.345" -> integer cents (rounded). null for
// blank/invalid input.
function toCents(input) {
  if (input === null || input === undefined) return null;
  const s = String(input).replace(/[$,\s]/g, '');
  if (s === '' || s === '-' || s === '.' || !/^-?\d*(\.\d*)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function centsInput(cents) {
  return cents === null || cents === undefined ? '' : (Number(cents) / 100).toFixed(2);
}

function toNumber(input) {
  if (input === null || input === undefined || String(input).trim() === '') return null;
  const n = Number(String(input).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// Current wall-clock time in the company timezone.
function nowText(date = new Date()) {
  return parts(date);
}

function today(date = new Date()) {
  return parts(date).slice(0, 10);
}

// Pure arithmetic on wall-clock text (no timezone conversion).
function addMinutes(ts, minutes) {
  return new Date(parseTs(ts) + minutes * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function addDays(dateStr, days) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// Monday of the week containing dateStr.
function weekStart(dateStr) {
  const d = new Date(String(dateStr).slice(0, 10) + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

// <input type="datetime-local"> "2026-11-10T14:30" -> "2026-11-10 14:30:00"
function fromLocalInput(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
  return m ? `${m[1]} ${m[2]}${m[3] || ':00'}` : null;
}

function toLocalInput(v) {
  return v ? String(v).slice(0, 16).replace(' ', 'T') : '';
}

function dateOnly(v) {
  if (!v) return null;
  const m = String(v).match(/^\d{4}-\d{2}-\d{2}$|^\d{4}-\d{2}-\d{2}(?=[ T])/);
  return m ? m[0] : null;
}

function shortDateTime(v) {
  return v ? String(v).slice(0, 16) : '';
}

function hours(minutes) {
  return (Math.round((Number(minutes || 0) / 60) * 100) / 100).toFixed(2);
}

function parseTs(v) {
  return Date.parse(String(v).replace(' ', 'T') + 'Z');
}

function minutesBetween(a, b) {
  if (!a || !b) return 0;
  return Math.max(0, Math.round((parseTs(b) - parseTs(a)) / 60000));
}

function digits(s) {
  return String(s || '').replace(/\D/g, '');
}

// Last 10 digits, so "+1 (555) 123-4567" and "555.123.4567" match.
function phoneKey(s) {
  const d = digits(s);
  if (!d) return null;
  return d.length > 10 ? d.slice(-10) : d;
}

function number(prefix, id) {
  return `${prefix}-${String(id).padStart(6, '0')}`;
}

function label(s) {
  return String(s || '').replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function clean(s, max = 5000) {
  if (s === null || s === undefined) return null;
  const t = String(s).trim().slice(0, max);
  return t === '' ? null : t;
}

function csv(rows, columns) {
  const esc = (v) => {
    let s = v === null || v === undefined ? '' : String(v);
    // Leading = + - @ would be evaluated as a formula by spreadsheet apps.
    if (/^[=+\-@]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const head = columns.map((c) => esc(c.label)).join(',');
  const body = rows.map((r) => columns.map((c) => esc(typeof c.value === 'function' ? c.value(r) : r[c.value])).join(','));
  return [head, ...body].join('\n');
}

module.exports = {
  setTimezone, timezone, validTimezone, addMinutes,
  money, toCents, centsInput, toNumber, nowText, today, addDays, weekStart, fromLocalInput, toLocalInput, dateOnly,
  shortDateTime, hours, parseTs, minutesBetween, digits, phoneKey, number, label, clean, csv,
};
