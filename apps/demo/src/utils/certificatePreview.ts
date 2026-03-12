export function buildCertificatePreview(content: string, bytes: Uint8Array) {
  const isPdf =
    bytes.length > 4 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d;

  if (isPdf) {
    const pdfBlob = new Blob([Uint8Array.from(bytes)], {
      type: "application/pdf",
    });
    return {
      previewKind: "pdf" as const,
      preview: "PDF preview available.",
      truncated: false,
      pdfUrl: URL.createObjectURL(pdfBlob),
    };
  }

  const printable = bytes.reduce((count, byte) => {
    const isLineBreak = byte === 10 || byte === 13 || byte === 9;
    const isAsciiPrintable = byte >= 32 && byte <= 126;
    return isLineBreak || isAsciiPrintable ? count + 1 : count;
  }, 0);
  const printableRatio = bytes.length > 0 ? printable / bytes.length : 1;
  const isTextPreview = printableRatio > 0.85;

  if (!isTextPreview) {
    return {
      previewKind: "binary" as const,
      preview:
        "This certificate is binary content and cannot be rendered as text preview.",
      truncated: false,
    };
  }

  const maxChars = 2400;
  const normalized = content.trim() || "(empty text content)";
  const truncated = normalized.length > maxChars;
  return {
    previewKind: "text" as const,
    preview: truncated ? `${normalized.slice(0, maxChars)}\n…` : normalized,
    truncated,
  };
}
