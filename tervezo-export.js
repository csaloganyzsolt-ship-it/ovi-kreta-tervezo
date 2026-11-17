// PDF, DOCX és ZIP exportok, nyomtatás.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

const MARGIN_MM = { compact: 10, comfortable: 12, spacious: 15 };

const PAGE_MM = { portrait: [210, 297], landscape: [297, 210] };

// Renders one document into an off-screen sheet using its own orientation and margin.
// Ugyanazt a tördelést (paginateDocument) használja, mint az előnézet, így a PDF/DOCX lapról lapra megegyezik vele.
async function buildPagesForDoc(docId) {
  const { orientation, margin } = getDocSettings(docId);
  const marginMm = MARGIN_MM[margin] || MARGIN_MM.comfortable;
  const host = document.createElement('div');
  host.className = 'document-sheet a4-host';
  host.dataset.margin = margin;
  host.dataset.orientation = orientation;
  host.style.cssText = 'position:absolute;left:-10000px;top:0;';
  host.innerHTML = buildDocumentHtml(lastResult, lastResult.request || buildGenerationPayload(), docId);
  document.body.appendChild(host);
  try {
    if (document.fonts?.ready) await document.fonts.ready;
    await nextFrame();
    paginateDocument(host);
    const pages = Array.from(host.querySelectorAll('.a4-page-body')).map((body) => body.innerHTML);
    return { pages, orientation, marginMm };
  } finally {
    host.remove();
  }
}

const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

function makePageElement(bodyHtml, orientation, marginMm) {
  const [width, height] = PAGE_MM[orientation];
  const element = document.createElement('div');
  element.className = 'document-sheet export-sheet';
  // Nincs position/z-index: az html2pdf overlay-be klónozza az elemet, ahol a fixed + negatív z-index üres képet adott.
  element.style.cssText = `width:${width}mm;height:${height - 0.6}mm;min-height:0;max-width:none;padding:${marginMm}mm;margin:0;box-sizing:border-box;overflow:hidden;box-shadow:none;background:#fff;`;
  element.innerHTML = bodyHtml;
  return element;
}

async function renderPdfBlob(docId) {
  const { pages, orientation, marginMm } = await buildPagesForDoc(docId);
  const [width, height] = PAGE_MM[orientation];
  const host = document.createElement('div');
  host.style.cssText = `position:absolute;left:-10000px;top:0;width:${width}mm;overflow:visible;pointer-events:none;`;
  document.body.appendChild(host);
  const options = {
    margin: 0,
    image: { type: 'jpeg', quality: 0.98 },
    html2canvas: { scale: 2, useCORS: true, backgroundColor: '#ffffff', scrollX: 0, scrollY: 0, logging: false },
    jsPDF: { unit: 'mm', format: 'a4', orientation }
  };
  try {
    const elements = pages.map((html) => host.appendChild(makePageElement(html, orientation, marginMm)));
    await nextFrame();
    await nextFrame();
    if (elements.some((element) => !element.offsetHeight || !element.offsetWidth)) {
      throw new Error('A dokumentum nem látható vagy nulla méretű, ezért a PDF nem készíthető el.');
    }
    const pdf = await window.html2pdf().set(options).from(elements[0]).toPdf().get('pdf');
    while (pdf.internal.getNumberOfPages() > 1) pdf.deletePage(pdf.internal.getNumberOfPages());
    for (let index = 1; index < elements.length; index += 1) {
      const canvas = await window.html2pdf().set(options).from(elements[index]).toCanvas().get('canvas');
      pdf.addPage('a4', orientation);
      pdf.addImage(canvas.toDataURL('image/jpeg', 0.98), 'JPEG', 0, 0, width, height);
    }
    return pdf.output('blob');
  } finally {
    host.remove();
  }
}

// Natív DOCX (valódi Word-táblázatok és bekezdések): minden szoftverben megjelenik, nem csak a Wordben.
function docxRunsFromNode(node, base = {}) {
  const { TextRun } = window.docx;
  const runs = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = child.textContent.replace(/\s+/g, ' ');
      if (text.trim() || text === ' ') runs.push(new TextRun({ color: '000000', ...base, text }));
    } else if (child.nodeName === 'BR') {
      runs.push(new TextRun({ break: 1 }));
    } else if (child.nodeType === 1) {
      const bold = ['STRONG', 'B'].includes(child.nodeName) || base.bold;
      const italics = ['EM', 'I'].includes(child.nodeName) || base.italics;
      runs.push(...docxRunsFromNode(child, { color: '000000', ...base, bold, ...(italics ? { italics: true } : {}) }));
    }
  });
  return runs;
}

// Oktatási célú táblázatok (academic-table): vékony szegély, színezett ismétlődő fejlécsor, a lapnál magasabb sor is törhető.
const ACADEMIC_HEADER_FILL = 'DCEFE6';

function docxTable(table, contentWidth) {
  const { Table, TableRow, TableCell, Paragraph, WidthType, BorderStyle, TableLayoutType, ShadingType } = window.docx;
  const academic = table.classList.contains('academic-table');
  const thematic = table.classList.contains('thematic-table');
  const cols = Array.from(table.querySelectorAll('col')).map((col) => parseFloat(col.style.width) || 0);
  const count = cols.length || table.rows[0].cells.length;
  const widths = (cols.length ? cols : Array(count).fill(100 / count)).map((pct) => Math.round(contentWidth * pct / 100));
  const line = { style: BorderStyle.SINGLE, size: academic ? 4 : 6, color: academic ? '444444' : '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const fontSize = thematic ? 16 : 20;
  const buildRow = (row, header) => new TableRow({
    tableHeader: header,
    cantSplit: !academic,
    children: Array.from(row.cells).map((cell, index) => {
      // A bekezdések a cellában lévő div-ekben is lehetnek: mindegyik külön Word-bekezdés.
      const paragraphs = Array.from(cell.querySelectorAll('p')).map((para) => new Paragraph({
        spacing: { after: thematic ? 50 : 100, line: thematic ? 240 : 276 },
        keepNext: para.classList.contains('cell-label'),
        children: docxRunsFromNode(para, { size: fontSize, bold: header, font: 'Arial', color: '000000' })
      }));
      return new TableCell({
        borders,
        width: { size: widths[index], type: WidthType.DXA },
        margins: thematic ? { top: 60, bottom: 60, left: 70, right: 70 } : { top: 80, bottom: 80, left: 110, right: 110 },
        ...(academic && header ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: ACADEMIC_HEADER_FILL } } : {}),
        children: paragraphs.length ? paragraphs : [new Paragraph({ children: docxRunsFromNode(cell, { size: fontSize, bold: header, font: 'Arial', color: '000000' }) })]
      });
    })
  });
  const rows = [];
  Array.from(table.tHead?.rows || []).forEach((row) => rows.push(buildRow(row, true)));
  Array.from(table.tBodies[0]?.rows || []).forEach((row) => rows.push(buildRow(row, false)));
  return new Table({
    borders: {
      top: line,
      bottom: line,
      left: line,
      right: line,
      insideHorizontal: line,
      insideVertical: line
    },
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows
  });
}

function docxMetaTable(block, contentWidth) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle, TableLayoutType, ShadingType } = window.docx;
  const academic = Boolean(block.querySelector('.academic-meta'));
  const line = { style: BorderStyle.SINGLE, size: 4, color: academic ? '444444' : '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const widths = academic
    ? [Math.round(contentWidth * 0.3), Math.round(contentWidth * 0.7)]
    : [Math.round(contentWidth * 0.28), Math.round(contentWidth * 0.72)];
  // Az oktatási célú fejléc értékei több bekezdést és dőlt/félkövér szöveget is tartalmazhatnak.
  const academicChildren = (cell) => {
    const paragraphs = Array.from(cell.querySelectorAll(':scope > p'));
    const sources = paragraphs.length ? paragraphs : [cell];
    return sources.map((source) => new Paragraph({
      spacing: { after: 40 },
      children: docxRunsFromNode(source, { size: 21, font: 'Arial', color: '000000' })
    }));
  };
  const rows = Array.from(block.querySelectorAll('.meta-row')).map((row) => new TableRow({
    cantSplit: !academic,
    children: [row.querySelector('.meta-label'), row.querySelector('.meta-value')].map((cell, index) => new TableCell({
      borders,
      width: { size: widths[index], type: WidthType.DXA },
      margins: { top: 70, bottom: 70, left: 110, right: 110 },
      ...(academic && index === 0 ? { shading: { type: ShadingType.CLEAR, color: 'auto', fill: ACADEMIC_HEADER_FILL } } : {}),
      children: academic && index === 1 && cell
        ? academicChildren(cell)
        : [new Paragraph({ children: [new TextRun({ text: cell?.textContent || '', bold: index === 0, size: 21, font: 'Arial', color: '000000' })] })]
    }))
  }));
  return new Table({
    borders: {
      top: line,
      bottom: line,
      left: line,
      right: line,
      insideHorizontal: line,
      insideVertical: line
    },
    width: { size: widths[0] + widths[1], type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows
  });
}

async function renderDocxBlob(docId) {
  if (!window.docx) throw new Error('A DOCX könyvtár nem tölthető be.');
  const { Document, Packer, Paragraph, TextRun, PageOrientation, HeadingLevel } = window.docx;
  const { orientation, margin } = getDocSettings(docId);
  const marginMm = MARGIN_MM[margin] || MARGIN_MM.comfortable;
  const marginTw = Math.round(marginMm * 56.7);
  const [pageW] = PAGE_MM[orientation];
  const contentWidth = Math.round(pageW * 56.7) - marginTw * 2;
  const source = document.createElement('div');
  source.innerHTML = buildDocumentHtml(lastResult, lastResult.request || buildGenerationPayload(), docId);

  const children = [];
  const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('.doc-header')) {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 0, after: 140 },
        children: [new TextRun({ text: node.querySelector('h2')?.textContent || '', bold: true, size: 34, font: 'Arial', color: '000000' })]
      }));
    } else if (node.matches('.doc-meta-block')) {
      children.push(docxMetaTable(node, contentWidth), spacer());
    } else if (node.tagName === 'H3') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        keepNext: true,
        spacing: { before: 200, after: 120 },
        children: [new TextRun({ text: node.textContent, bold: true, size: 26, font: 'Arial', color: '000000' })]
      }));
    } else if (node.tagName === 'TABLE') {
      children.push(docxTable(node, contentWidth), spacer());
    } else if (node.tagName === 'P') {
      children.push(new Paragraph({ spacing: { after: 120, line: 288 }, children: docxRunsFromNode(node, { size: 22, font: 'Arial', color: '000000' }) }));
    } else {
      node.childNodes.forEach(visit);
    }
  };
  source.childNodes.forEach(visit);

  const doc = new Document({
    creator: 'OviTervező',
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838, orientation: orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          margin: { top: marginTw, right: marginTw, bottom: marginTw, left: marginTw }
        }
      },
      children
    }]
  });
  return Packer.toBlob(doc);
}

function getActiveDocument() {
  const list = getDocumentList();
  return list.find((doc) => doc.id === currentDocKey()) || list[0];
}

async function exportAsPdf() {
  if (!window.html2pdf) {
    alert('A PDF export könyvtár nem tölthető be. Ellenőrizd az internetkapcsolatot.');
    return;
  }
  if (!lastResult) {
    alert('Nincs megjeleníthető dokumentum a PDF exporthez.');
    return;
  }
  if (guardLocked()) return;
  const doc = getActiveDocument();
  downloadBlob(await renderPdfBlob(doc.id), `${doc.fileBase}.pdf`);
}

async function exportAsDocx() {
  if (!window.docx) {
    alert('A DOCX export könyvtár nem tölthető be. Ellenőrizd az internetkapcsolatot.');
    return;
  }
  if (!lastResult) {
    alert('Nincs megjeleníthető dokumentum a DOCX exporthoz.');
    return;
  }
  if (guardLocked()) return;
  const doc = getActiveDocument();
  downloadBlob(await renderDocxBlob(doc.id), `${doc.fileBase}.docx`);
}

async function buildZipBlob(onProgress = () => {}) {
  const zip = new window.JSZip();
  const list = getDocumentList();
  for (let index = 0; index < list.length; index += 1) {
    const doc = list[index];
    onProgress(index + 1, list.length);
    zip.file(`${doc.fileBase}.pdf`, await renderPdfBlob(doc.id));
    zip.file(`${doc.fileBase}.docx`, await renderDocxBlob(doc.id));
  }
  return zip.generateAsync({ type: 'blob' });
}

async function exportAllAsZip() {
  if (!window.JSZip || !window.html2pdf || !window.docx) {
    alert('Az exportkönyvtárak (JSZip, PDF, DOCX) nem tölthetők be. Ellenőrizd az internetkapcsolatot.');
    return;
  }
  if (!lastResult || guardLocked()) return;
  const button = document.getElementById('downloadZipBtn');
  const originalLabel = button.textContent;
  button.disabled = true;
  try {
    const blob = await buildZipBlob((done, total) => { button.textContent = `ZIP készítése... ${done}/${total}`; });
    downloadBlob(blob, 'ovi-kreta-heti-terv.zip');
  } catch (error) {
    showGenerationError(`A ZIP letöltés sikertelen: ${error?.message || error}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

// A nyomtatás ugyanazt a lapméretet és margót használja, mint az előnézet (a @page nem lehet dokumentumonként eltérő, ezért dinamikus).
function applyPrintPageStyle() {
  const { orientation, margin } = getDocSettings();
  const [width, height] = PAGE_MM[orientation];
  const marginMm = MARGIN_MM[margin] || MARGIN_MM.comfortable;
  let style = document.getElementById('dynamicPrintStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamicPrintStyle';
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: A4 ${orientation}; margin: 0; }
          @media print { .a4-page { width: ${width}mm !important; height: ${height - 0.5}mm !important; padding: ${marginMm}mm !important; box-sizing: border-box; } }`;
}
