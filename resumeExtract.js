const path = require("path");
const { PDFParse } = require("pdf-parse");
const mammoth = require("mammoth");

const MAX_RESUME_CHARS = 45_000;
/** Keep ≤ typical serverless request body limits (e.g. Vercel ~4.5 MB). */
const MAX_FILE_BYTES = 4 * 1024 * 1024;

function extFromName(name) {
  return path.extname(name || "").toLowerCase();
}

/**
 * @param {Buffer} buffer
 * @param {string} [mimetype]
 * @param {string} [originalname]
 * @returns {Promise<{ ok: true, text: string, truncated: boolean } | { ok: false, error: string }>}
 */
async function extractResumeText(buffer, mimetype, originalname) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { ok: false, error: "Resume file is empty." };
  }
  if (buffer.length > MAX_FILE_BYTES) {
    return {
      ok: false,
      error: `Resume file is too large (max ${MAX_FILE_BYTES / 1024 / 1024} MB).`,
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
      error: "Unsupported file type. Please upload a PDF or .docx resume.",
    };
  }

  try {
    let raw = "";
    if (isPdf) {
      /** pdf-parse v2+ exposes `PDFParse` (class), not a default `pdfParse(buffer)` function. */
      if (typeof PDFParse !== "function") {
        throw new Error("PDFParse is not available from pdf-parse package.");
      }
      const parser = new PDFParse({ data: buffer });
      try {
        const data = await parser.getText();
        raw = typeof data.text === "string" ? data.text : "";
      } finally {
        await parser.destroy().catch(() => {});
      }
    } else {
      const result = await mammoth.extractRawText({ buffer });
      raw = result.value || "";
    }

    const normalized = raw.replace(/\s+/g, " ").trim();
    if (!normalized || normalized.length < 20) {
      return {
        ok: false,
        error:
          "Could not extract readable text from this file. Try a text-based PDF or .docx, or export your resume again.",
      };
    }

    const truncated = normalized.length > MAX_RESUME_CHARS;
    const text = truncated
      ? normalized.slice(0, MAX_RESUME_CHARS)
      : normalized;
    return { ok: true, text, truncated };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn("[resumeExtract] failed", msg);
    return {
      ok: false,
      error: "Could not read this resume file. Try PDF or .docx.",
    };
  }
}

module.exports = {
  extractResumeText,
  MAX_RESUME_CHARS,
  MAX_FILE_BYTES,
};
