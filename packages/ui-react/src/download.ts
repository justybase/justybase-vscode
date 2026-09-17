/**
 * Triggers a browser download for an in-memory blob. The anchor is attached
 * to the document because detached `anchor.click()` downloads are ignored by
 * Firefox; Chrome and Edge accept either form.
 */
export function downloadBlobFile(fileName: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    const revokeObjectUrl = URL.revokeObjectURL;
    if (typeof revokeObjectUrl === 'function') window.setTimeout(() => revokeObjectUrl(url), 100);
  }
}
