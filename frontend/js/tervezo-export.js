// PDF (pdfmake, vektoros), DOCX és ZIP exportok, nyomtatás.
// Klasszikus script (nem ES modul): a felső szintű deklarációk közös globális hatókörben élnek.

// A Facebook, Messenger és Instagram beépített böngészője (WebView) a Blob URL-es letöltést iOS-en és sok Android készüléken némán eldobja.
const IN_APP_BROWSER_PATTERN = /FBAN|FBAV|FB_IAB|Instagram|Messenger/i;

function isInAppBrowser(userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '') {
  return IN_APP_BROWSER_PATTERN.test(String(userAgent || ''));
}

function showInAppDownloadTip() {
  const tip = document.getElementById('inAppDownloadTip');
  if (tip) tip.hidden = false;
}

function anchorDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Beépített böngészőben először a rendszer megosztás-/mentés panelje (Web Share fájlokkal), ha az nem elérhető, a hagyományos letöltés; mindkét esetben segítő tipp is megjelenik.
async function downloadBlob(blob, filename) {
  if (isInAppBrowser()) {
    showInAppDownloadTip();
    try {
      const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], title: filename });
        return;
      }
    } catch (error) {
      if (error?.name === 'AbortError') return;
    }
  }
  anchorDownload(blob, filename);
}

// Egységes oldalmargó minden formátumban és minden oldalon (az előnézet, a PDF és a DOCX is ezt használja).
const PAGE_MARGIN_MM = 15;

const PAGE_MM = { portrait: [210, 297], landscape: [297, 210] };

const PT_PER_MM = 72 / 25.4;

// ===== Közös dokumentummodell =====
// Az előnézet HTML-jéből (buildDocumentHtml) egyetlen, formátumfüggetlen blokklista készül; a DOCX és a PDF is ebből épül.
// Blokkok: title, heading, paragraph, meta, table. Egy szövegfutás: { text, bold?, italics? }; a sortörés { text: '\n', br: true }.

function exportRunsFromNode(node, base = {}) {
  const runs = [];
  node.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      const text = child.textContent.replace(/\s+/g, ' ');
      if (text.trim() || text === ' ') runs.push({ text, ...base });
    } else if (child.nodeName === 'BR') {
      runs.push({ text: '\n', br: true });
    } else if (child.nodeType === 1) {
      const next = { ...base };
      if (['STRONG', 'B'].includes(child.nodeName)) next.bold = true;
      if (['EM', 'I'].includes(child.nodeName)) next.italics = true;
      runs.push(...exportRunsFromNode(child, next));
    }
  });
  return runs;
}

// A bekezdés elején/végén a felesleges szóköz (a HTML-formázásból) eltűnik.
function trimRuns(runs) {
  const result = runs.map((run) => ({ ...run }));
  while (result.length && !result[0].br && !result[0].text.trim()) result.shift();
  while (result.length && !result.at(-1).br && !result.at(-1).text.trim()) result.pop();
  if (result.length && !result[0].br) result[0].text = result[0].text.replace(/^\s+/, '');
  if (result.length && !result.at(-1).br) result.at(-1).text = result.at(-1).text.replace(/\s+$/, '');
  return result;
}

function exportParagraph(node) {
  return { runs: trimRuns(exportRunsFromNode(node)), label: node.classList.contains('cell-label') };
}

function exportCell(cell) {
  const paragraphs = Array.from(cell.querySelectorAll('p')).map(exportParagraph).filter((paragraph) => paragraph.runs.length);
  if (paragraphs.length) return { paragraphs };
  const runs = trimRuns(exportRunsFromNode(cell));
  return { paragraphs: runs.length ? [{ runs, label: false }] : [] };
}

function exportTable(table) {
  const cols = Array.from(table.querySelectorAll('col')).map((col) => parseFloat(col.style.width) || 0);
  const count = cols.length || table.rows[0].cells.length;
  return {
    type: 'table',
    academic: table.classList.contains('academic-table'),
    thematic: table.classList.contains('thematic-table'),
    widths: cols.length ? cols : Array(count).fill(100 / count),
    header: Array.from(table.tHead?.rows || []).map((row) => Array.from(row.cells).map(exportCell)),
    rows: Array.from(table.tBodies[0]?.rows || []).map((row) => Array.from(row.cells).map(exportCell))
  };
}

function exportMeta(block) {
  return {
    type: 'meta',
    academic: Boolean(block.querySelector('.academic-meta')),
    rows: Array.from(block.querySelectorAll('.meta-row')).map((row) => ({
      label: row.querySelector('.meta-label')?.textContent.trim() || '',
      value: exportCell(row.querySelector('.meta-value') || row)
    }))
  };
}

function buildExportModel(docId) {
  const source = document.createElement('div');
  source.innerHTML = buildDocumentHtml(lastResult, lastResult.request || buildGenerationPayload(), docId);
  const blocks = [];
  const visit = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches('.doc-header')) {
      blocks.push({ type: 'title', text: node.querySelector('h2')?.textContent.trim() || '' });
    } else if (node.matches('.doc-meta-block')) {
      blocks.push(exportMeta(node));
    } else if (node.tagName === 'H3') {
      blocks.push({ type: 'heading', text: node.textContent.trim() });
    } else if (node.tagName === 'TABLE') {
      blocks.push(exportTable(node));
    } else if (node.tagName === 'P') {
      const paragraph = exportParagraph(node);
      if (paragraph.runs.length) blocks.push({ type: 'paragraph', runs: paragraph.runs, className: node.className });
    } else {
      node.childNodes.forEach(visit);
    }
  };
  source.childNodes.forEach(visit);
  return { orientation: getDocOrientation(lastResult), title: blocks.find((block) => block.type === 'title')?.text || 'OviTervező', blocks };
}

// ===== PDF (pdfmake): valódi vektoros szöveg, fix margók, ismétlődő táblázatfejléc =====

const PDF_PAGE_PT = { portrait: [595.28, 841.89], landscape: [841.89, 595.28] };

// Egy táblázatsor tervezett legnagyobb magassága a lap tartalmi magasságának hányadában: ennél magasabb sorok kisebb sorokra bomlanak.
const PDF_MAX_ROW_SHARE = 0.3;

function pdfRuns(runs, base = {}) {
  return runs.map((run) => (run.br
    ? { text: '\n' }
    : { text: run.text, ...(run.bold || base.bold ? { bold: true } : {}), ...(run.italics ? { italics: true } : {}) }));
}

// pdfmake nem méri előre a cellát: a sor-felosztáshoz a bekezdés magasságát a karakterszámból becsüljük (a valódi tördelést a pdfmake végzi).
function pdfEstimateHeight(paragraph, widthPt, fontSize) {
  const charsPerLine = Math.max(4, widthPt / (fontSize * 0.52));
  const text = paragraph.runs.map((run) => run.text).join('');
  const lines = text.split('\n').reduce((total, line) => total + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
  return lines * fontSize * 1.25 + 2.5;
}

// Egy oszlop bekezdéseit legfeljebb `budget` becsült magasságú részekre osztja; a címke nem marad a rész végén.
function pdfChunkParagraphs(items, budget) {
  const chunks = [];
  let current = [];
  let used = 0;
  items.forEach((item, index) => {
    const next = items[index + 1];
    const need = item.paragraph.label && next ? item.height + next.height : item.height;
    if (current.length && used + need > budget) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += item.height;
  });
  if (current.length) chunks.push(current);
  return chunks;
}

function pdfTable(block, contentWidth, contentHeight) {
  const fontSize = block.thematic ? 7.5 : 9.5;
  const padX = block.thematic ? 3.5 : 5;
  const padY = block.thematic ? 3 : 4;
  // A pdfmake oszlopszélessége a belső tartalomé: a cellamargó és a keretvonal ráadódik, ezért levonjuk, hogy a táblázat a margókon belül maradjon.
  const usable = contentWidth - (block.widths.length + 1) * 0.5 - 0.5;
  const widths = block.widths.map((pct) => Math.floor((usable * pct / 100 - 2 * padX) * 100) / 100);

  const paragraphNode = (paragraph, bold) => ({
    text: pdfRuns(paragraph.runs, { bold: bold || paragraph.label }),
    fontSize,
    lineHeight: 1.2,
    margin: [0, 0, 0, 2.5]
  });
  const cellNode = (cell, bold) => (cell.paragraphs.length ? { stack: cell.paragraphs.map((paragraph) => paragraphNode(paragraph, bold)) } : '');

  const body = block.header.map((row) => row.map((cell) => cellNode(cell, true)));
  const continuation = block.header.map(() => false);
  const maxRowHeight = contentHeight * PDF_MAX_ROW_SHARE;

  block.rows.forEach((row) => {
    const columns = row.map((cell, index) => cell.paragraphs.map((paragraph) => ({
      paragraph,
      height: pdfEstimateHeight(paragraph, widths[index], fontSize)
    })));
    const totals = columns.map((items) => items.reduce((sum, item) => sum + item.height, 0));
    const tallest = Math.max(0, ...totals);
    if (tallest <= maxRowHeight * 1.15) {
      body.push(row.map((cell) => cellNode(cell, false)));
      continuation.push(false);
      return;
    }
    const slices = Math.ceil(tallest / maxRowHeight);
    const chunked = columns.map((items) => pdfChunkParagraphs(items, tallest / slices));
    const count = Math.max(...chunked.map((chunks) => chunks.length));
    for (let slice = 0; slice < count; slice += 1) {
      body.push(chunked.map((chunks) => (chunks[slice]
        ? { stack: chunks[slice].map((item) => paragraphNode(item.paragraph, false)) }
        : '')));
      continuation.push(slice > 0);
    }
  });

  return {
    table: { headerRows: block.header.length || 0, ...(block.header.length ? { keepWithHeaderRows: 1 } : {}), dontBreakRows: true, widths, body },
    layout: {
      // Fehér háttér, vékony fekete keret; az egy sorból származó szeletek között nincs vízszintes vonal.
      hLineWidth: (index, node) => (index > 0 && index < node.table.body.length && continuation[index] ? 0 : 0.5),
      vLineWidth: () => 0.5,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
      paddingLeft: () => padX,
      paddingRight: () => padX,
      paddingTop: () => padY,
      paddingBottom: () => padY
    },
    margin: [0, 0, 0, 10]
  };
}

function pdfMetaTable(block, contentWidth) {
  const usable = contentWidth - 3 * 0.5 - 0.5;
  const labelShare = block.academic ? 0.3 : 0.28;
  const labelWidth = Math.floor((usable * labelShare - 10) * 100) / 100;
  const paragraphNode = (paragraph) => ({ text: pdfRuns(paragraph.runs), fontSize: 9.5, lineHeight: 1.25, margin: [0, 0, 0, 2] });
  return {
    table: {
      widths: [labelWidth, Math.floor((usable * (1 - labelShare) - 10) * 100) / 100],
      dontBreakRows: true,
      body: block.rows.map((row) => [
        { text: row.label, bold: true, fontSize: 9.5, lineHeight: 1.25 },
        row.value.paragraphs.length ? { stack: row.value.paragraphs.map(paragraphNode) } : ''
      ])
    },
    layout: {
      hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#000000', vLineColor: () => '#000000',
      paddingLeft: () => 5, paddingRight: () => 5, paddingTop: () => 4, paddingBottom: () => 2
    },
    margin: [0, 0, 0, 12]
  };
}

function buildPdfDefinition(docId) {
  const model = buildExportModel(docId);
  const [pageWidth, pageHeight] = PDF_PAGE_PT[model.orientation];
  const margin = PAGE_MARGIN_MM * PT_PER_MM;
  const contentWidth = pageWidth - 2 * margin;
  const contentHeight = pageHeight - 2 * margin;
  const content = model.blocks.map((block) => {
    if (block.type === 'title') return { text: block.text, fontSize: 16, bold: true, margin: [0, 0, 0, 10], headlineLevel: 1 };
    if (block.type === 'heading') return { text: block.text, fontSize: 11.5, bold: true, margin: [0, 10, 0, 5], headlineLevel: 1 };
    if (block.type === 'meta') return pdfMetaTable(block, contentWidth);
    if (block.type === 'table') return pdfTable(block, contentWidth, contentHeight);
    return { text: pdfRuns(block.runs), fontSize: 10, lineHeight: 1.3, margin: [0, 0, 0, 4] };
  });
  return {
    info: { title: model.title, creator: 'OviTervező' },
    pageSize: 'A4',
    pageOrientation: model.orientation,
    pageMargins: [margin, margin, margin, margin],
    defaultStyle: { font: 'Roboto', fontSize: 10, color: '#000000' },
    // Címsor nem maradhat a lap alján a következő tartalom nélkül.
    pageBreakBefore: (node, following) => node.headlineLevel === 1 && following.length === 0,
    content
  };
}

async function renderPdfBlob(docId) {
  if (typeof window.pdfMake?.createPdf !== 'function') throw new Error('A PDF-készítő (pdfmake) nem tölthető be.');
  const definition = buildPdfDefinition(docId);
  const buffer = await new Promise((resolve, reject) => {
    try {
      window.pdfMake.createPdf(definition).getBuffer(resolve);
    } catch (error) {
      reject(error);
    }
  });
  return new Blob([buffer], { type: 'application/pdf' });
}

// ===== DOCX: ugyanabból a modellből, natív Word-táblázatokkal és bekezdésekkel =====

function docxRuns(runs, base = {}) {
  const { TextRun } = window.docx;
  return runs.map((run) => {
    if (run.br) return new TextRun({ break: 1 });
    const bold = run.bold || base.bold;
    return new TextRun({ color: '000000', ...base, bold: undefined, text: run.text, ...(bold ? { bold: true } : {}), ...(run.italics ? { italics: true } : {}) });
  });
}

function docxTable(block, contentWidth) {
  const { Table, TableRow, TableCell, Paragraph, WidthType, BorderStyle, TableLayoutType } = window.docx;
  const widths = block.widths.map((pct) => Math.round(contentWidth * pct / 100));
  // Színezés nélkül, fehér háttéren, vékony fekete szegéllyel.
  const line = { style: BorderStyle.SINGLE, size: block.academic ? 4 : 6, color: '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const fontSize = block.thematic ? 16 : 20;
  const buildRow = (cells, header) => new TableRow({
    tableHeader: header,
    cantSplit: !block.academic,
    children: cells.map((cell, index) => new TableCell({
      borders,
      width: { size: widths[index], type: WidthType.DXA },
      margins: block.thematic ? { top: 60, bottom: 60, left: 70, right: 70 } : { top: 80, bottom: 80, left: 110, right: 110 },
      children: cell.paragraphs.length
        ? cell.paragraphs.map((paragraph) => new Paragraph({
          spacing: { after: block.thematic ? 50 : 100, line: block.thematic ? 240 : 276 },
          keepNext: paragraph.label,
          children: docxRuns(paragraph.runs, { size: fontSize, bold: header, font: 'Arial' })
        }))
        : [new Paragraph({ children: [] })]
    }))
  });
  return new Table({
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    width: { size: widths.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows: [...block.header.map((cells) => buildRow(cells, true)), ...block.rows.map((cells) => buildRow(cells, false))]
  });
}

function docxMetaTable(block, contentWidth) {
  const { Table, TableRow, TableCell, Paragraph, TextRun, WidthType, BorderStyle, TableLayoutType } = window.docx;
  const line = { style: BorderStyle.SINGLE, size: 4, color: '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const widths = block.academic
    ? [Math.round(contentWidth * 0.3), Math.round(contentWidth * 0.7)]
    : [Math.round(contentWidth * 0.28), Math.round(contentWidth * 0.72)];
  const rows = block.rows.map((row) => new TableRow({
    cantSplit: !block.academic,
    children: [
      new TableCell({
        borders,
        width: { size: widths[0], type: WidthType.DXA },
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: [new Paragraph({ children: [new TextRun({ text: row.label, bold: true, size: 21, font: 'Arial', color: '000000' })] })]
      }),
      new TableCell({
        borders,
        width: { size: widths[1], type: WidthType.DXA },
        margins: { top: 70, bottom: 70, left: 110, right: 110 },
        children: row.value.paragraphs.length
          ? row.value.paragraphs.map((paragraph) => new Paragraph({ spacing: { after: 40 }, children: docxRuns(paragraph.runs, { size: 21, font: 'Arial' }) }))
          : [new Paragraph({ children: [] })]
      })
    ]
  }));
  return new Table({
    borders: { top: line, bottom: line, left: line, right: line, insideHorizontal: line, insideVertical: line },
    width: { size: widths[0] + widths[1], type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    rows
  });
}

async function renderDocxBlob(docId) {
  if (!window.docx) throw new Error('A DOCX könyvtár nem tölthető be.');
  const { Document, Packer, Paragraph, TextRun, PageOrientation, HeadingLevel } = window.docx;
  const model = buildExportModel(docId);
  const marginTw = Math.round(PAGE_MARGIN_MM * 56.7);
  const contentWidth = Math.round(PAGE_MM[model.orientation][0] * 56.7) - marginTw * 2;

  const children = [];
  const spacer = () => new Paragraph({ spacing: { after: 120 }, children: [] });
  model.blocks.forEach((block) => {
    if (block.type === 'title') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 0, after: 140 },
        children: [new TextRun({ text: block.text, bold: true, size: 34, font: 'Arial', color: '000000' })]
      }));
    } else if (block.type === 'meta') {
      children.push(docxMetaTable(block, contentWidth), spacer());
    } else if (block.type === 'heading') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        keepNext: true,
        spacing: { before: 200, after: 120 },
        children: [new TextRun({ text: block.text, bold: true, size: 26, font: 'Arial', color: '000000' })]
      }));
    } else if (block.type === 'table') {
      children.push(docxTable(block, contentWidth), spacer());
    } else {
      children.push(new Paragraph({ spacing: { after: 120, line: 288 }, children: docxRuns(block.runs, { size: 22, font: 'Arial' }) }));
    }
  });

  const doc = new Document({
    creator: 'OviTervező',
    sections: [{
      properties: {
        page: {
          size: { width: 11906, height: 16838, orientation: model.orientation === 'landscape' ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
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
  if (!window.pdfMake) {
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
  if (!window.JSZip || !window.pdfMake || !window.docx) {
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

// A nyomtatás ugyanazt a lapméretet és margót használja, mint az előnézet (a @page dinamikus, mert a tematikus terv fekvő).
function applyPrintPageStyle() {
  const orientation = getDocOrientation();
  const [width, height] = PAGE_MM[orientation];
  let style = document.getElementById('dynamicPrintStyle');
  if (!style) {
    style = document.createElement('style');
    style.id = 'dynamicPrintStyle';
    document.head.appendChild(style);
  }
  style.textContent = `@page { size: A4 ${orientation}; margin: 0; }
          @media print { .a4-page { width: ${width}mm !important; height: ${height - 0.5}mm !important; padding: ${PAGE_MARGIN_MM}mm !important; box-sizing: border-box; } }`;
}
