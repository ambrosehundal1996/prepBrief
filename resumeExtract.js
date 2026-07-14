const path = require("path");
/** pdf-parse@1.x: text-only extraction via pdf.js (works on Vercel; v2 pulls in canvas/DOM). */
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

const MAX_RESUME_CHARS = 45_000;
/** Keep ≤ typical serverless request body limits (e.g. Vercel ~4.5 MB). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function extFromName(name) {
  return path.extname(name || "").toLowerCase();
}

/**
 * Shared PDF/.docx → text extraction for uploaded documents.
 * @param {Buffer} buffer
 * @param {string | undefined} mimetype
 * @param {string | undefined} originalname
 * @param {{ label: string, maxChars: number }} opts label appears in user-facing errors ("resume", "job description")
 * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, error: string }>}
 */
async function extractDocumentText(buffer, mimetype, originalname, { label, maxChars }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: `The ${label} file is empty.` };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `The ${label} file is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
    };
  }

  const ext = extFromName(originalname);
  const mime = String(mimetype || "").toLowerCase();

  const isPdf =
    mime === "application/pdf" ||
    mime.includes("pdf") ||
    ext === ".pdf";
  const isDocx =
    mime ===
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx";
  const isLegacyDoc = mime === "application/msword" || ext === ".doc";

  if (isLegacyDoc) {
    return {
      ok: false,
      error:
        "Old .doc format is not supported. Please save as PDF or .docx.",
    };
  }

  if (!isPdf && !isDocx) {
    return {
      ok: false,
      error: `Unsupported file type. Please upload a PDF or .docx ${label}.`,
    };
  }

  try {
    let raw = "";
    if (isPdf) {
      if (typeof pdfParse !== "function") {
        throw new Error("pdf-parse is not available.");
      }
      const data = await pdfParse(buffer);
      raw = typeof data.text === "string" ? data.text : "";
    } else {
      const result = await mammoth.extractRawText({ buffer });
      raw = result.value || "";
    }

    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length < 20) {
      return {
        ok: false,
        error: `Could not extract readable text from this file. Try a text-based PDF or .docx, or export your ${label} again.`,
      };
    }

    const truncated = normalized.length > maxChars;
    const text = truncated ? normalized.slice(0, maxChars) : normalized;
    return { ok: true, text, truncated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[docExtract:${label}] failed`, msg);
    return {
      ok: false,
      error: `Could not read this ${label} file. Try PDF or .docx.`,
    };
  }
}

/**
 * @param {Buffer} buffer
 * @param {string} [mimetype]
 * @param {string} [originalname]
 */
function extractResumeText(buffer, mimetype, originalname) {
  return extractDocumentText(buffer, mimetype, originalname, {
    label: "resume",
    maxChars: MAX_RESUME_CHARS,
  });
}

module.exports = {
  extractDocumentText,
  extractResumeText,
  MAX_RESUME_CHARS,
  MAX_FILE_BYTES,
};
