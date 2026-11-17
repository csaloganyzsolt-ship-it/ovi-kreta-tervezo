'use strict';

// A Gemini-válasz szigorú olvasói: hiányzó vagy hibás mezőnél hibát dobnak, soha nem találnak ki tartalmat.

function generationError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function readText(value, field, allowEmpty = false) {
  if (value === null || value === undefined) {
    if (allowEmpty) return '';
    throw generationError(`Hiányzó vagy hibás szövegmező a Gemini válaszában: ${field}.`);
  }
  if (typeof value !== 'string') {
    throw generationError(`Hiányzó vagy hibás szövegmező a Gemini válaszában: ${field}.`);
  }
  if (!allowEmpty && !value.trim()) {
    throw generationError(`Hiányzó vagy hibás szövegmező a Gemini válaszában: ${field}.`);
  }
  return value.trim();
}

function readStringArray(value, field) {
  if (!Array.isArray(value) || !value.length) {
    throw generationError(`Hiányzó vagy üres szövegtömb a Gemini válaszában: ${field}.`);
  }
  return value.map((part, index) => readText(part, `${field}[${index}]`));
}

// A tevékenységmenet soronként bekezdéstömb; egyetlen szövegből az üres sorok mentén bontjuk.
function readParagraphs(value, field) {
  const paragraphs = typeof value === 'string'
    ? value.split(/\r?\n\s*\r?\n/).map((part) => part.trim()).filter(Boolean)
    : value;
  return readStringArray(paragraphs, field);
}

function clampRows(rows) {
  if (!Array.isArray(rows)) {
    throw generationError('A Gemini válaszában a kidolgozas_tablazat mező nem tömb.');
  }

  // Validate, but never shorten text, deduplicate notes, or silently remove rows.
  return rows.map((row, index) => {
    const field = `kidolgozas_tablazat[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw generationError(`Hibás táblázatsor a Gemini válaszában: ${field}.`);
    }
    return {
      ido: readText(row.ido, `${field}.ido`),
      tevekenyseg_menete: readParagraphs(row.tevekenyseg_menete, `${field}.tevekenyseg_menete`),
      modszerek_megjegyzesek: readText(row.modszerek_megjegyzesek, `${field}.modszerek_megjegyzesek`)
    };
  });
}

function normalizeTable(rows) {
  const normalized = clampRows(rows);
  if (!normalized.length) {
    throw generationError('A Gemini válaszában a kidolgozas_tablazat üres. Nem készült dokumentum.');
  }
  return normalized;
}

module.exports = { generationError, readText, readStringArray, readParagraphs, clampRows, normalizeTable };
