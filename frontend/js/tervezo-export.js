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

// Egységes oldalmargó és lapméret minden formátumban (az előnézet, a PDF és a DOCX is a közös DOC_LAYOUT-ból olvassa).
const PAGE_MARGIN_MM = DOC_LAYOUT.marginMm;

const PAGE_MM = DOC_LAYOUT.pageMm;

// A közös sormagasság (a betűméret többszöröse) átszámítása a Word és a pdfmake saját alapsormagasságára.
const docxLineSpacing = (lineHeight) => Math.round(lineHeight / DOC_LAYOUT.nativeLineFactor.word * 240);
const pdfLineHeight = (lineHeight) => Math.round(lineHeight / DOC_LAYOUT.nativeLineFactor.pdf * 1000) / 1000;

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
  return { orientation: getDocOrientation(lastResult, docId), title: blocks.find((block) => block.type === 'title')?.text || 'OviTervező', blocks };
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
  return lines * fontSize * DOC_LAYOUT.lineHeight.table + DOC_LAYOUT.spacingPt.cellParagraphAfter;
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
  const fontSize = block.thematic ? DOC_LAYOUT.fontPt.thematic : DOC_LAYOUT.fontPt.table;
  const { x: padX, y: padY } = block.thematic ? DOC_LAYOUT.cellPadPt.thematic : DOC_LAYOUT.cellPadPt.table;
  const border = DOC_LAYOUT.borderPt;
  // A pdfmake oszlopszélessége a belső tartalomé: a cellamargó és a keretvonal ráadódik, ezért levonjuk, hogy a táblázat a margókon belül maradjon.
  const usable = contentWidth - (block.widths.length + 1) * border - border;
  const widths = block.widths.map((pct) => Math.floor((usable * pct / 100 - 2 * padX) * 100) / 100);

  const paragraphNode = (paragraph, bold) => ({
    text: pdfRuns(paragraph.runs, { bold: bold || paragraph.label }),
    fontSize,
    lineHeight: pdfLineHeight(DOC_LAYOUT.lineHeight.table),
    margin: [0, 0, 0, DOC_LAYOUT.spacingPt.cellParagraphAfter]
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
      hLineWidth: (index, node) => (index > 0 && index < node.table.body.length && continuation[index] ? 0 : border),
      vLineWidth: () => border,
      hLineColor: () => '#000000',
      vLineColor: () => '#000000',
      paddingLeft: () => padX,
      paddingRight: () => padX,
      paddingTop: () => padY,
      paddingBottom: () => padY
    },
    margin: [0, 0, 0, DOC_LAYOUT.spacingPt.blockGap]
  };
}

function pdfMetaTable(block, contentWidth) {
  const border = DOC_LAYOUT.borderPt;
  const { x: padX, y: padY } = DOC_LAYOUT.cellPadPt.meta;
  const fontSize = DOC_LAYOUT.fontPt.meta;
  const usable = contentWidth - 3 * border - border;
  const labelShare = block.academic ? DOC_LAYOUT.metaLabelShare.academic : DOC_LAYOUT.metaLabelShare.standard;
  const labelWidth = Math.floor((usable * labelShare - 2 * padX) * 100) / 100;
  const lineHeight = pdfLineHeight(DOC_LAYOUT.lineHeight.meta);
  const paragraphNode = (paragraph) => ({ text: pdfRuns(paragraph.runs), fontSize, lineHeight, margin: [0, 0, 0, DOC_LAYOUT.spacingPt.cellParagraphAfter] });
  return {
    table: {
      widths: [labelWidth, Math.floor((usable * (1 - labelShare) - 2 * padX) * 100) / 100],
      dontBreakRows: true,
      body: block.rows.map((row) => [
        { text: row.label, bold: true, fontSize, lineHeight },
        row.value.paragraphs.length ? { stack: row.value.paragraphs.map(paragraphNode) } : ''
      ])
    },
    layout: {
      hLineWidth: () => border, vLineWidth: () => border, hLineColor: () => '#000000', vLineColor: () => '#000000',
      paddingLeft: () => padX, paddingRight: () => padX, paddingTop: () => padY, paddingBottom: () => padY
    },
    margin: [0, 0, 0, DOC_LAYOUT.spacingPt.blockGap]
  };
}

function buildPdfDefinition(docId) {
  const model = buildExportModel(docId);
  const [pageWidth, pageHeight] = PDF_PAGE_PT[model.orientation];
  const margin = PAGE_MARGIN_MM * PT_PER_MM;
  const contentWidth = pageWidth - 2 * margin;
  const contentHeight = pageHeight - 2 * margin;
  const { fontPt, spacingPt } = DOC_LAYOUT;
  const content = model.blocks.map((block) => {
    if (block.type === 'title') return { text: block.text, fontSize: fontPt.title, bold: true, margin: [0, 0, 0, spacingPt.titleAfter], headlineLevel: 1 };
    if (block.type === 'heading') return { text: block.text, fontSize: fontPt.heading, bold: true, margin: [0, spacingPt.headingBefore, 0, spacingPt.headingAfter], headlineLevel: 1 };
    if (block.type === 'meta') return pdfMetaTable(block, contentWidth);
    if (block.type === 'table') return pdfTable(block, contentWidth, contentHeight);
    return { text: pdfRuns(block.runs), fontSize: fontPt.body, lineHeight: pdfLineHeight(DOC_LAYOUT.lineHeight.body), margin: [0, 0, 0, spacingPt.paragraphAfter] };
  });
  return {
    info: { title: model.title, creator: 'OviTervező' },
    pageSize: 'A4',
    pageOrientation: model.orientation,
    pageMargins: [margin, margin, margin, margin],
    defaultStyle: { font: 'Roboto', fontSize: fontPt.body, color: '#000000' },
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
  // Színezés nélkül, fehér háttéren, vékony fekete szegéllyel (a méret nyolcad pontban).
  const line = { style: BorderStyle.SINGLE, size: Math.round(DOC_LAYOUT.borderPt * 8), color: '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const fontSize = Math.round((block.thematic ? DOC_LAYOUT.fontPt.thematic : DOC_LAYOUT.fontPt.table) * 2);
  const pad = block.thematic ? DOC_LAYOUT.cellPadPt.thematic : DOC_LAYOUT.cellPadPt.table;
  const margins = { top: pad.y * TWIP_PER_PT, bottom: pad.y * TWIP_PER_PT, left: pad.x * TWIP_PER_PT, right: pad.x * TWIP_PER_PT };
  const buildRow = (cells, header) => new TableRow({
    tableHeader: header,
    cantSplit: !block.academic,
    children: cells.map((cell, index) => new TableCell({
      borders,
      width: { size: widths[index], type: WidthType.DXA },
      margins,
      children: cell.paragraphs.length
        ? cell.paragraphs.map((paragraph) => new Paragraph({
          spacing: { after: DOC_LAYOUT.spacingPt.cellParagraphAfter * TWIP_PER_PT, line: docxLineSpacing(DOC_LAYOUT.lineHeight.table) },
          keepNext: paragraph.label,
          children: docxRuns(paragraph.runs, { size: fontSize, bold: header, font: DOC_LAYOUT.fontFamily })
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
  const line = { style: BorderStyle.SINGLE, size: Math.round(DOC_LAYOUT.borderPt * 8), color: '000000' };
  const borders = { top: line, bottom: line, left: line, right: line };
  const labelShare = block.academic ? DOC_LAYOUT.metaLabelShare.academic : DOC_LAYOUT.metaLabelShare.standard;
  const widths = [Math.round(contentWidth * labelShare), Math.round(contentWidth * (1 - labelShare))];
  const size = Math.round(DOC_LAYOUT.fontPt.meta * 2);
  const { x, y } = DOC_LAYOUT.cellPadPt.meta;
  const margins = { top: y * TWIP_PER_PT, bottom: y * TWIP_PER_PT, left: x * TWIP_PER_PT, right: x * TWIP_PER_PT };
  const lineSpacing = docxLineSpacing(DOC_LAYOUT.lineHeight.meta);
  const rows = block.rows.map((row) => new TableRow({
    cantSplit: true,
    children: [
      new TableCell({
        borders,
        width: { size: widths[0], type: WidthType.DXA },
        margins,
        children: [new Paragraph({ spacing: { line: lineSpacing }, children: [new TextRun({ text: row.label, bold: true, size, font: DOC_LAYOUT.fontFamily, color: '000000' })] })]
      }),
      new TableCell({
        borders,
        width: { size: widths[1], type: WidthType.DXA },
        margins,
        children: row.value.paragraphs.length
          ? row.value.paragraphs.map((paragraph) => new Paragraph({
            spacing: { after: DOC_LAYOUT.spacingPt.cellParagraphAfter * TWIP_PER_PT, line: lineSpacing },
            children: docxRuns(paragraph.runs, { size, font: DOC_LAYOUT.fontFamily })
          }))
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
  const { Document, Packer, Paragraph, TextRun, PageOrientation, HeadingLevel, LineRuleType } = window.docx;
  const model = buildExportModel(docId);
  const { fontPt, spacingPt, fontFamily } = DOC_LAYOUT;
  const marginTw = Math.round(PAGE_MARGIN_MM * TWIP_PER_MM);
  const contentWidth = Math.round(PAGE_MM[model.orientation][0] * TWIP_PER_MM) - marginTw * 2;

  const children = [];
  // A táblázatok közti térköz pontosan a közös blockGap (a PDF-ben és az előnézetben is ennyi).
  const spacer = () => new Paragraph({ spacing: { before: 0, after: 0, line: spacingPt.blockGap * TWIP_PER_PT, ...(LineRuleType ? { lineRule: LineRuleType.EXACT } : {}) }, children: [] });
  model.blocks.forEach((block) => {
    if (block.type === 'title') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_1,
        keepNext: true,
        spacing: { before: 0, after: spacingPt.titleAfter * TWIP_PER_PT },
        children: [new TextRun({ text: block.text, bold: true, size: Math.round(fontPt.title * 2), font: fontFamily, color: '000000' })]
      }));
    } else if (block.type === 'meta') {
      children.push(docxMetaTable(block, contentWidth), spacer());
    } else if (block.type === 'heading') {
      children.push(new Paragraph({
        heading: HeadingLevel.HEADING_2,
        keepNext: true,
        spacing: { before: spacingPt.headingBefore * TWIP_PER_PT, after: spacingPt.headingAfter * TWIP_PER_PT },
        children: [new TextRun({ text: block.text, bold: true, size: Math.round(fontPt.heading * 2), font: fontFamily, color: '000000' })]
      }));
    } else if (block.type === 'table') {
      children.push(docxTable(block, contentWidth), spacer());
    } else {
      children.push(new Paragraph({
        spacing: { after: spacingPt.paragraphAfter * TWIP_PER_PT, line: docxLineSpacing(DOC_LAYOUT.lineHeight.body) },
        children: docxRuns(block.runs, { size: Math.round(fontPt.body * 2), font: fontFamily })
      }));
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
