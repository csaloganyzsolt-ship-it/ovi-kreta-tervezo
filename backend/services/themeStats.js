'use strict';

// A téma-statisztika egyetlen forrása: a `documents` táblában tárolt, sikeresen legenerált tervezetek `request.theme` mezője.
// Az Admin főoldal „Top témák” táblája és a Téma-ajánlók fül „Használat” oszlopa is ezt a logikát használja,
// így a kézzel beírt és a chipről választott témák egyaránt számítanak, és a két nézet nem térhet el egymástól.
const PAGE_SIZE = 1000;
const MAX_ROWS = 50000;

// Kis- és nagybetű-, szóköz-érzéketlen kulcs (a „Márton-nap” és a „ márton-nap ” ugyanaz a téma).
function normalizeThemeKey(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase('hu');
}

// themes: téma-szövegek listája. Visszatérés: Map<kulcs, { title, count }>; a title a leggyakoribb írásmód.
function countThemes(themes) {
  const groups = new Map();
  for (const theme of themes) {
    const key = normalizeThemeKey(theme);
    if (!key) continue;
    const group = groups.get(key) || { count: 0, spellings: new Map() };
    const spelling = String(theme).replace(/\s+/g, ' ').trim();
    group.count += 1;
    group.spellings.set(spelling, (group.spellings.get(spelling) || 0) + 1);
    groups.set(key, group);
  }
  const result = new Map();
  for (const [key, group] of groups) {
    const [title] = [...group.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'hu'))[0];
    result.set(key, { title, count: group.count });
  }
  return result;
}

function topThemes(counts, limit = 10) {
  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.title.localeCompare(b.title, 'hu'))
    .slice(0, limit)
    .map(({ title, count }) => ({ name: title, count }));
}

async function loadThemeCounts(client) {
  const themes = [];
  for (let from = 0; from < MAX_ROWS; from += PAGE_SIZE) {
    const { data, error } = await client.from('documents').select('document_id, request:data->plan->request').order('document_id', { ascending: true }).range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`A témák számlálása sikertelen: ${error.message || 'adatbázishiba'}`);
    themes.push(...(data || []).map((row) => row.request?.theme));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return countThemes(themes);
}

module.exports = { normalizeThemeKey, countThemes, topThemes, loadThemeCounts };
