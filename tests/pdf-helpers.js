// Valódi pdfmake-PDF a jsdom-tesztekhez, és annak ellenőrzése pdf.js-szel (szöveg, pozíció, rajzoló műveletek).
const pdfMake = require('pdfmake/build/pdfmake');

pdfMake.addVirtualFileSystem(require('pdfmake/build/vfs_fonts'));

// A jsdom-ban készült definíciót a Node-világba másoljuk (a layout- és pageBreakBefore-függvények megmaradnak).
function plainClone(value) {
  if (Array.isArray(value)) return value.map(plainClone);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, plainClone(item)]));
  return value;
}

function installPdfMake(window) {
  const definitions = [];
  window.pdfMake = {
    createPdf(definition) {
      definitions.push(definition);
      return { getBuffer: (callback) => pdfMake.createPdf(plainClone(definition)).getBuffer(callback) };
    }
  };
  // A jsdom Blob-ja nem tud arrayBuffer()-t: a FileReader-rel pótoljuk.
  if (!window.Blob.prototype.arrayBuffer) {
    window.Blob.prototype.arrayBuffer = function arrayBuffer() {
      return new Promise((resolve, reject) => {
        const reader = new window.FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(this);
      });
    };
  }
  return definitions;
}

let pdfjsPromise;
const loadPdfjs = () => { pdfjsPromise ||= import('pdfjs-dist/legacy/build/pdf.mjs'); return pdfjsPromise; };

async function readPdf(blob) {
  const pdfjs = await loadPdfjs();
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const raw = Buffer.from(bytes).toString('latin1');
  const document = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: false, verbosity: 0 }).promise;
  const { OPS } = pdfjs;
  const paintOps = new Set([OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke, OPS.showText, OPS.showSpacedText].filter((op) => op !== undefined));
  // A pdfmake minden szövegfutás után üres, fekete "fill"-t ír; ezért a színt követjük: csak nem fekete festés számít kitöltésnek.
  const countColoredPaints = (operators) => {
    let color = [0, 0, 0];
    let colored = 0;
    operators.fnArray.forEach((fn, index) => {
      const args = operators.argsArray[index];
      if (fn === OPS.setFillRGBColor) color = [args[0], args[1], args[2]];
      else if (fn === OPS.setFillGray) color = [args[0], args[0], args[0]];
      else if (fn === OPS.setFillCMYKColor) color = args[3] === 255 ? [0, 0, 0] : [255, 255, 255];
      if (paintOps.has(fn) && color.some((channel) => channel !== 0)) colored += 1;
    });
    return colored;
  };
  const pages = [];
  for (let number = 1; number <= document.numPages; number += 1) {
    const page = await document.getPage(number);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const operators = await page.getOperatorList();
    const items = content.items
      .filter((item) => item.str.trim())
      .map((item) => ({ str: item.str, x: item.transform[4], y: item.transform[5], width: item.width, height: item.height }));
    pages.push({
      number,
      width: viewport.width,
      height: viewport.height,
      items,
      text: content.items.map((item) => item.str).join(''),
      compact: content.items.map((item) => item.str).join('').replace(/\s+/g, ''),
      fills: countColoredPaints(operators),
      images: operators.fnArray.filter((fn) => [OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageMaskXObject].includes(fn)).length
    });
  }
  return { pages, raw, text: pages.map((page) => page.compact).join('') };
}

module.exports = { installPdfMake, readPdf };
