/**
 * Note export — the download family. One place owns every way a note
 * leaves the app: plain text, PDF, docx, standalone HTML, plus the
 * file-name convention ("Notes-<date>.<ext>") that goes with them.
 *
 * The heavy libraries (jspdf, docx) ride lazy chunks fetched on first
 * use — never on boot. Blob URLs are revoked right after the click so
 * repeated exports don't leak.
 *
 * Consumers: the app's download menu (app.ts) and the picture-in-picture
 * window's save button (pip-window.ts).
 */

function getCurrentDate(): string {
  const currentDate = new Date();

  return (
    currentDate.getDate() + '-' + (currentDate.getMonth() + 1) + '-' + currentDate.getFullYear()
  );
}

export function getFileName(): string {
  return 'Notes-' + getCurrentDate() + '.txt';
}

export function getPdfFileName(): string {
  return 'Notes-' + getCurrentDate() + '.pdf';
}

export function getDocxFileName(): string {
  return 'Notes-' + getCurrentDate() + '.docx';
}

export function getHtmlFileName(): string {
  return 'Notes-' + getCurrentDate() + '.html';
}

export function getMarkdownFileName(): string {
  return 'Notes-' + getCurrentDate() + '.md';
}

export function saveTextAsFile(
  textToWrite: string,
  fileNameToSaveAs: string,
  mime: string = 'text/plain',
): void {
  const textFileAsBlob = new Blob([textToWrite], { type: mime });
  const downloadLink = document.createElement('a');
  downloadLink.download = fileNameToSaveAs;
  downloadLink.innerHTML = 'Download File';

  const webkitURL = (window as Window & { webkitURL?: typeof URL }).webkitURL;
  const url =
    webkitURL != null
      ? webkitURL.createObjectURL(textFileAsBlob)
      : window.URL.createObjectURL(textFileAsBlob);
  downloadLink.href = url;
  if (webkitURL == null) {
    downloadLink.style.display = 'none';
    document.body.appendChild(downloadLink);
  }

  downloadLink.click();

  // Revoke the Blob URL after the click is dispatched. Without this every
  // export leaks a Blob reference (and its URL mapping) until the document
  // is unloaded — repeated exports bloat memory and the browser's URL table.
  // The 0 ms timeout lets Safari flush the navigation before the URL is
  // taken back; modern browsers honour the click synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function exportNotesAsPDF(textToWrite: string, fileNameToSaveAs: string): void {
  // jsPDF is heavy, so it is only fetched when a PDF export is requested.
  void import('jspdf').then(({ jsPDF }) => {
    const pdf = new jsPDF();
    const marginLeft = 10;
    const marginTop = 10;

    // Width of text area
    const maxWidth = 180;

    const lineHeight = 10;

    // Height of a single page
    const pageHeight = pdf.internal.pageSize.height;

    // Initial Y position for text
    let yPosition = marginTop;

    // Split content into lines that fit within maxWidth
    const lines = pdf.splitTextToSize(textToWrite, maxWidth);

    lines.forEach((line: string) => {
      if (yPosition + lineHeight > pageHeight) {
        pdf.addPage(); // Add a new page if content exceeds page height
        yPosition = marginTop; // Reset Y position for new page
      }
      pdf.text(line, marginLeft, yPosition);
      yPosition += lineHeight;
    });

    pdf.save(fileNameToSaveAs);
  });
}

export function exportNotesAsDocx(textToWrite: string, fileNameToSaveAs: string): void {
  // The docx bundle is heavy, so it is only fetched on demand.
  void import('docx').then(({ Document, Paragraph, TextRun, Packer }) => {
    const doc = new Document({
      sections: [
        {
          properties: {},
          children: [
            new Paragraph({
              children: [
                new TextRun({
                  text: textToWrite,
                }),
              ],
            }),
          ],
        },
      ],
    });

    Packer.toBlob(doc).then((blob) => {
      const downloadLink = document.createElement('a');
      const url = window.URL.createObjectURL(blob);
      downloadLink.href = url;
      downloadLink.download = fileNameToSaveAs;
      document.body.appendChild(downloadLink);
      downloadLink.click();
      document.body.removeChild(downloadLink);
      // Release the Blob reference so repeated exports don't leak.
      setTimeout(() => URL.revokeObjectURL(url), 0);
    });
  });
}

export function downloadHTML(htmlContent: string, fileNameToSaveAs: string): void {
  // `htmlContent` arrives pre-sanitised from the editor's formatting subset.
  const html = `<html>
        <head><meta charset="utf-8"><title>Notes</title></head>
        <body>
            <div style="white-space: pre-wrap; word-wrap: break-word; font-family: system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.55; padding: 24px;">${htmlContent}</div>
        </body>
    </html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const a = document.createElement('a');
  const url = URL.createObjectURL(blob);
  a.href = url;
  a.download = fileNameToSaveAs;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Release the Blob reference so repeated exports don't leak.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
