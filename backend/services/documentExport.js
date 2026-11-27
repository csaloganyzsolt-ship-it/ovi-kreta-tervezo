'use strict';

// A tervezet .docx / .pdf / .zip fájljait szerveroldalon, AI-újragenerálás nélkül állítja elő a Supabase-ben tárolt tervből.
// Nincs másolt export-kód: ugyanazokat a frontend szkripteket (tervezo-core/academic/preview/export) futtatja jsdom-ban,
// amelyeket a böngésző is használ, így a vevő karakterre ugyanazt a dokumentumot kapja.

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const FRONTEND_JS = path.join(__dirname, '..', '..', 'frontend', 'js');
const SCRIPTS = ['tervezo-core.js', 'tervezo-academic.js', 'tervezo-weekly.js', 'tervezo-preview.js', 'tervezo-export.js'];

// A szerveren nincs fizetési zárolás és űrlap: a tárolt, feloldott terv teljes tartalma készül el.
const SERVER_STUBS = `
function isPlanLocked() { return false; }
function buildGenerationPayload() { return {}; }
function persistDraftState() {}
window.__planExport = {
  set(result) { lastResult = result; },
  documents: () => getDocumentList(lastResult),
  pdf: (id) => renderPdfBlob(id),
  docx: (id) => renderDocxBlob(id)
};
`;

let sourceCache = null;
function frontendSource() {
  if (!sourceCache) sourceCache = SCRIPTS.map((file) => fs.readFileSync(path.join(FRONTEND_JS, file), 'utf8')).join('\n;\n') + SERVER_STUBS;
  return sourceCache;
}

// A jsdom-ban készült definíciót a Node-világba másoljuk (a layout- és pageBreakBefore-függvények megmaradnak).
function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainClone(item)]));
  return value;
}

let pdfMake = null;
function loadPdfMake() {
  if (!pdfMake) {
    pdfMake = require('pdfmake/build/pdfmake');
    pdfMake.addVirtualFileSystem(require('pdfmake/build/vfs_fonts'));
  }
  return pdfMake;
}

function createExporter(plan) {
  if (!plan || typeof plan !== 'object') throw Object.assign(new Error('A tervezet tartalma hiányzik.'), { status: 404 });
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', runScripts: 'outside-only' });
  const { window } = dom;
  const maker = loadPdfMake();
  window.Blob = Blob;
  window.docx = require('docx');
  window.JSZip = require('jszip');
  window.pdfMake = { createPdf: (definition) => ({ getBuffer: (callback) => maker.createPdf(plainClone(definition)).getBuffer(callback) }) };
  window.eval(frontendSource());
  window.__planExport.set(plan);
  return { api: window.__planExport, close: () => window.close() };
}

async function toBuffer(blob) {
  return Buffer.from(await blob.arrayBuffer());
}

// A böngészős kézbesítéssel azonos fájlkészlet: napi terv → PDF + DOCX, heti terv → egyetlen ZIP.
async function buildDeliveryFiles(plan) {
  const { api, close } = createExporter(plan);
  try {
    if (plan.is_weekly === true) {
      // Ugyanaz a ZIP-felépítés, mint a böngészőben (buildZipBlob): minden dokumentumhoz egy PDF és egy DOCX.
      const zip = new (require('jszip'))();
      for (const doc of api.documents()) {
        zip.file(`${doc.fileBase}.pdf`, await toBuffer(await api.pdf(doc.id)));
        zip.file(`${doc.fileBase}.docx`, await toBuffer(await api.docx(doc.id)));
      }
      return [{ filename: 'OviTervezo_heti_csomag.zip', content: await zip.generateAsync({ type: 'nodebuffer' }) }];
    }
    const doc = api.documents()[0];
    return [
      { filename: `${doc.fileBase}.pdf`, content: await toBuffer(await api.pdf(doc.id)) },
      { filename: `${doc.fileBase}.docx`, content: await toBuffer(await api.docx(doc.id)) }
    ];
  } finally {
    close();
  }
}

module.exports = { buildDeliveryFiles };
