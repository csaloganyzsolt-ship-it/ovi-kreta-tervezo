'use strict';

const WEEKDAYS = ['Hétfő', 'Kedd', 'Szerda', 'Csütörtök', 'Péntek'];

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const fail = (field, rule) => new ValidationError(`Érvénytelen beállítás: ${field} (${rule}).`);

function text(value, field, max) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw fail(field, 'szöveg szükséges');
  if (value.length > max) throw fail(field, `legfeljebb ${max} karakter`);
  return value;
}

function bool(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'boolean') throw fail(field, 'igaz/hamis érték szükséges');
  return value;
}

function oneOf(value, field, allowed) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!allowed.includes(value)) throw fail(field, `megengedett értékek: ${allowed.join(', ')}`);
  return value;
}

function list(value, field, maxItems, maxLength) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return text(value, field, maxItems * maxLength);
  if (!Array.isArray(value)) throw fail(field, 'tömb szükséges');
  if (value.length > maxItems) throw fail(field, `legfeljebb ${maxItems} elem`);
  return value.map((item, index) => {
    if (typeof item !== 'string') throw fail(`${field}[${index}]`, 'szöveg szükséges');
    if (item.length > maxLength) throw fail(`${field}[${index}]`, `legfeljebb ${maxLength} karakter`);
    return item;
  });
}

function weekdayKeyedObject(value, field, readValue) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail(field, 'objektum szükséges');
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!WEEKDAYS.includes(key)) throw fail(field, `a kulcsok csak hétköznapok lehetnek, ismeretlen: ${key.slice(0, 30)}`);
    result[key] = readValue(entry, `${field}.${key}`);
  }
  return result;
}

function validateChildCount(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 40) {
    throw fail('childCount', 'egész szám 1 és 40 között');
  }
  return value;
}

function validateDetailLevel(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) {
    throw fail('detailLevel', 'szám 0 és 100 között');
  }
  return value;
}

function validateSelectedDays(value) {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > WEEKDAYS.length) throw fail('selectedDays', 'legfeljebb 5 hétköznap');
  for (const day of value) {
    if (!WEEKDAYS.includes(day)) throw fail('selectedDays', `csak hétköznapok engedélyezettek: ${String(day).slice(0, 30)}`);
  }
  return [...new Set(value)];
}

function validateCustomNotes(value) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) throw fail('customNotes', 'objektum szükséges');
  const result = {};
  for (const key of ['primary', 'groupNote', 'requiredText', 'ideaNote', 'customRequest']) {
    const entry = text(value[key], `customNotes.${key}`, 4000);
    if (entry !== undefined) result[key] = entry;
  }
  const needs = list(value.specialNeeds, 'customNotes.specialNeeds', 20, 200);
  if (needs !== undefined) result.specialNeeds = needs;
  return result;
}

function validatePreviousPlanContext(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return text(value, 'previousPlanContext', 20000);
  if (typeof value === 'object') return JSON.stringify(value).slice(0, 20000);
  throw fail('previousPlanContext', 'szöveg vagy objektum szükséges');
}

// Fehérlistás másolat: csak az ismert mezők jutnak tovább (a prompt és a tárolt kérés is ebből épül).
function validateGeneratePayload(payload) {
  const clean = {};
  const put = (key, value) => { if (value !== undefined) clean[key] = value; };

  put('duration', oneOf(payload.duration, 'duration', ['Napi', 'Heti']));
  // Régi kliensek a napi/heti jelzést még planMode néven küldték: ezt planKind-ra képezzük le.
  const legacyKind = ['daily', 'weekly'].includes(payload.planMode) ? payload.planMode : undefined;
  put('planMode', oneOf(legacyKind ? undefined : payload.planMode, 'planMode', ['standard', 'academic']));
  put('planKind', oneOf(payload.planKind ?? legacyKind, 'planKind', ['daily', 'weekly']));
  put('weeklyScope', oneOf(payload.weeklyScope, 'weeklyScope', ['summary', 'package']));
  put('weeklyProgressionType', oneOf(payload.weeklyProgressionType, 'weeklyProgressionType', ['progressive', 'area_focused']));
  put('requestedModel', text(payload.requestedModel, 'requestedModel', 60));
  for (const [key, max] of [
    ['theme', 300], ['group', 100], ['kindergartenName', 200], ['kindergartenProfile', 300],
    ['teacherName', 200], ['studentName', 200], ['groupName', 200], ['dateValue', 40], ['fridayClosingType', 200],
    ['tevekenysegForma', 300], ['elozmeny', 4000], ['customNote', 4000], ['availableTools', 4000],
    ['blacklist', 4000], ['iktCustomApp', 300]
  ]) put(key, text(payload[key], key, max));

  if (payload.energyLevel !== undefined && payload.energyLevel !== null) {
    if (typeof payload.energyLevel === 'number' && Number.isFinite(payload.energyLevel)) clean.energyLevel = payload.energyLevel;
    else put('energyLevel', text(payload.energyLevel, 'energyLevel', 60));
  }
  for (const key of ['includeDailyBreakdown', 'hasPreschoolers', 'iktEnabled', 'showLiteratureAtBottom', 'preview']) {
    put(key, bool(payload[key], key));
  }

  // Oktatási tervnél az irodalomjegyzék kötelező, a kliens kapcsolójától függetlenül.
  if (clean.planMode === 'academic') clean.showLiteratureAtBottom = true;

  clean.childCount = validateChildCount(payload.childCount);
  put('detailLevel', validateDetailLevel(payload.detailLevel));
  put('selectedDays', validateSelectedDays(payload.selectedDays));
  put('focusAreas', list(payload.focusAreas, 'focusAreas', 12, 200));
  put('specialNeeds', list(payload.specialNeeds, 'specialNeeds', 20, 200));
  put('selectedGoals', list(payload.selectedGoals, 'selectedGoals', 30, 200));
  put('iktTools', list(payload.iktTools, 'iktTools', 20, 100));
  put('weeklyFocusAreas', weekdayKeyedObject(payload.weeklyFocusAreas, 'weeklyFocusAreas', (entry, field) => {
    const areas = list(entry, field, 10, 200);
    if (areas === undefined) throw fail(field, 'tömb vagy szöveg szükséges');
    return areas;
  }));
  put('customNotes', validateCustomNotes(payload.customNotes));
  put('previousPlanContext', validatePreviousPlanContext(payload.previousPlanContext));
  return clean;
}

module.exports = { validateGeneratePayload, ValidationError, WEEKDAYS };
