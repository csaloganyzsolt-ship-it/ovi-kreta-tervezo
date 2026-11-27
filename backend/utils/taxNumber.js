'use strict';

// Magyar adószám: 8 jegyű törzsszám (az utolsó jegy ellenőrző számjegy), opcionálisan -ÁFA-kód (1–5) -megye-kód (2 jegy) kiegészítéssel.
// Elfogadott: 12345678, 12345678-1-23, 12345678123. Érvénytelen érték null; a kimenet a Számlázz.hu / NAV által várt alak.
function normalizeHuTaxNumber(value) {
  const digits = String(value ?? '').trim().replace(/[\s-]+/g, '');
  if (!digits) return '';
  if (!/^\d{8}(\d{3})?$/.test(digits)) return null;
  const weights = [9, 7, 3, 1, 9, 7, 3, 1];
  const sum = weights.reduce((total, weight, index) => total + weight * Number(digits[index]), 0);
  if (sum % 10 !== 0) return null;
  if (digits.length === 8) return digits;
  if (!/^[1-5]$/.test(digits[8]) || digits.slice(9) === '00') return null;
  return `${digits.slice(0, 8)}-${digits[8]}-${digits.slice(9)}`;
}

module.exports = { normalizeHuTaxNumber };
