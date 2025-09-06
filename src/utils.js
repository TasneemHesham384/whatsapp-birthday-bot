import fs from 'fs';
import path from 'path';
import { parse } from 'csv-parse/sync';

/**
 * Sanitize and normalize phone number to E.164 without plus.
 * - removes non-digits
 * - if starts with 0, prepend COUNTRY_CODE
 * - if already starts with country code, keep as is
 */
export function normalizeNumber(raw, countryCode='20') {
  if (!raw) return null;
  const digits = String(raw).replace(/\D+/g, '');
  if (!digits) return null;
  if (digits.startsWith(countryCode)) return digits;
  if (digits.startsWith('0')) return countryCode + digits.slice(1);
  return digits; // assume already E.164 without +
}

export function toWhatsAppId(numberDigits) {
  if (!numberDigits) return null;
  return `${numberDigits}@c.us`;
}

export function fileExists(p) {
  try { fs.accessSync(p, fs.constants.F_OK); return true; } catch { return false; }
}

export function loadBirthdays(dataDir, countryCode='20') {
  const csvPath = path.join(dataDir, 'birthdays.csv');
  const jsonPath = path.join(dataDir, 'birthdays.json');

  let rows = [];
  if (fileExists(csvPath)) {
    const csv = fs.readFileSync(csvPath, 'utf8');
    rows = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  } else if (fileExists(jsonPath)) {
    rows = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } else {
    return [];
  }

  return rows
    .map(r => ({
      name: r.name?.trim(),
      number: normalizeNumber(r.number, countryCode),
      birthday: String(r.birthday).trim(), // YYYY-MM-DD
    }))
    .filter(r => r.name && r.birthday);
}

/** Check if birthday matches given month/day (handles Feb 29) */
export function isBirthdayToday(birthdayISO, month, day, handleFeb29='feb28') {
  // birthdayISO: YYYY-MM-DD
  const [y, m, d] = birthdayISO.split('-').map(n => parseInt(n, 10));
  if (!m || !d) return false;

  if (m === 2 && d === 29) {
    // special case
    if (month === 2 && day === 29) return true; // leap year
    if (handleFeb29 === 'feb28' && month === 2 && day === 28) return true;
    return false;
  }

  return (m === month && d === day);
}
