'use strict';

// Szerverszintű napi generálási plafon: IP-váltogatással sem szállhat el a Gemini-költség.
// A plafon forrása: érvényes DAILY_GENERATION_CAP környezeti változó (üzemeltetői felülírás) > system_settings.daily_generation_cap > 250.
// A számláló a szerverpéldány memóriájában él, UTC-napváltáskor nullázódik.
const settingsService = require('./settingsService');

const DEFAULT_DAILY_GENERATION_CAP = settingsService.DEFAULT_DAILY_GENERATION_CAP;
const dailyGenerations = { day: '', count: 0 };

function envCap(env = process.env) {
  const configured = Number(env.DAILY_GENERATION_CAP);
  return Number.isInteger(configured) && configured > 0 ? configured : null;
}

function dailyGenerationCap(env = process.env) {
  return envCap(env) ?? settingsService.dailyGenerationCapOf(settingsService.peek());
}

function rollover(now) {
  const day = now.toISOString().slice(0, 10);
  if (dailyGenerations.day !== day) {
    dailyGenerations.day = day;
    dailyGenerations.count = 0;
  }
  return day;
}

function reserveDailyGeneration(env = process.env, now = new Date()) {
  rollover(now);
  if (dailyGenerations.count >= dailyGenerationCap(env)) return false;
  dailyGenerations.count += 1;
  return true;
}

function releaseDailyGeneration() {
  if (dailyGenerations.count > 0) dailyGenerations.count -= 1;
}

function resetDailyGenerations() {
  dailyGenerations.day = '';
  dailyGenerations.count = 0;
}

// Az admin áttekintéshez: a mai felhasznált keret, a plafon és annak forrása.
function dailyGenerationStatus(env = process.env, now = new Date()) {
  const day = rollover(now);
  return { day, count: dailyGenerations.count, cap: dailyGenerationCap(env), source: envCap(env) ? 'env' : 'settings' };
}

module.exports = { DEFAULT_DAILY_GENERATION_CAP, dailyGenerationCap, reserveDailyGeneration, releaseDailyGeneration, resetDailyGenerations, dailyGenerationStatus };
