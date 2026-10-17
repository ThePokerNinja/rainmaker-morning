/**
 * Branded research report PDF export (Rainmaker DS tokens).
 * Uses jsPDF text layout (reliable on mobile; no html2canvas blank-page bug).
 */
(function (global) {
  "use strict";

  const ACCENT = [78, 184, 201];
  const BULL = [45, 184, 168];
  const INK = [12, 18, 24];
  const MUTED = [100, 116, 141];
  const CARD = [22, 31, 42];

  const JSPDF_SRC =
    "https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js";

  function loadScriptOnce(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-rm-pdf-lib="' + src + '"]')) {
        resolve();
        return;
      }
      const s = document.createElement("script");
      s.src = src;
      s.async = true;
      s.dataset.rmPdfLib = src;
      s.onload = function () {
        resolve();
      };
      s.onerror = function () {
        reject(new Error("Failed to load " + src));
      };
      document.head.appendChild(s);
    });
  }

  async function ensurePdfLibs() {
    await loadScriptOnce(JSPDF_SRC);
    if (!global.jspdf) {
      throw new Error("PDF library unavailable");
    }
  }

  function fmtTime(ts) {
    if (!ts) return "-";
    try {
      return new Date(ts * 1000).toLocaleString();
    } catch (e) {
      return "-";
    }
  }

  function reportFilename(idea) {
    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    return "rainmaker-research-" + sid + ".pdf";
  }

  function stripMarkdown(line) {
    return String(line || "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#+\s+/, "")
      .replace(/^\s*-\s+/, "")
      .trim();
  }

  function parseMarkdownSections(md) {
    const sections = [];
    const lines = String(md || "").split("\n");
    let current = { title: "", lines: [] };

    function flush() {
      if (!current.title && !current.lines.length) return;
      sections.push({
        title: current.title,
        body: current.lines.join("\n").trim(),
      });
      current = { title: "", lines: [] };
    }

    lines.forEach(function (line) {
      const h2 = line.match(/^##\s+(.+)/);
      const h1 = line.match(/^#\s+(.+)/);
      if (h2) {
        flush();
        current.title = h2[1].trim();
        return;
      }
      if (h1 && h1[1].toLowerCase() !== "research report") {
        flush();
        current.title = h1[1].trim();
        return;
      }
      if (/^\*\*Prompt:\*\*/i.test(line)) return;
      current.lines.push(line);
    });
    flush();
    return sections.filter(function (s) {
      return s.title || s.body;
    });
  }

  function bodyLines(body) {
    return String(body || "")
      .split("\n")
      .map(stripMarkdown)
      .filter(Boolean)
      .map(function (line) {
        return line.startsWith("-") || line.startsWith(" - ") ? " -  " + line.replace(/^[- - ]\s*/, "") : line;
      });
  }

  async function download(idea, report, detail) {
    const raw = (report && report.body) || "";
    if (!raw || !idea) {
      throw new Error("No report to export");
    }
    await ensurePdfLibs();

    const jsPDF = global.jspdf.jsPDF;
    const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const marginX = 48;
    const marginBottom = 52;
    const maxW = pageW - marginX * 2;
    let y = 0;

    const sid = idea.short_id || (idea.id || "").slice(0, 8);
    const prompt = idea.prompt || "Research report";
    const summary = idea.summary || "";
    const status = (idea.status || "done").toUpperCase();
    const updated = fmtTime(idea.updated_at || idea.created_at);

    function drawTopBand() {
      doc.setFillColor.apply(doc, ACCENT);
      doc.rect(0, 0, pageW, 5, "F");
      doc.setFillColor.apply(doc, BULL);
      doc.rect(0, 5, pageW, 3, "F");
    }

    function newPage() {
      doc.addPage();
      drawTopBand();
      y = 44;
    }

    function ensureSpace(need) {
      if (y + need > pageH - marginBottom) {
        newPage();
      }
    }

    function writeLines(lines, opts) {
      const fontSize = (opts && opts.size) || 10;
      const lineH = fontSize * 1.45;
      const style = (opts && opts.style) || "normal";
      const color = (opts && opts.color) || INK;
      doc.setFont("helvetica", style);
      doc.setFontSize(fontSize);
      doc.setTextColor.apply(doc, color);
      lines.forEach(function (line) {
        const wrapped = doc.splitTextToSize(line, maxW);
        ensureSpace(wrapped.length * lineH + 4);
        doc.text(wrapped, marginX, y);
        y += wrapped.length * lineH + ((opts && opts.gap) || 4);
      });
    }

    function writeSectionTitle(title) {
      ensureSpace(28);
      doc.setDrawColor.apply(doc, ACCENT);
      doc.setLineWidth(0.75);
      doc.line(marginX, y, pageW - marginX, y);
      y += 14;
      doc.setFont("helvetica", "bold");
      doc.setFontSize(9);
      doc.setTextColor.apply(doc, ACCENT);
      doc.text(String(title).toUpperCase(), marginX, y);
      y += 16;
    }

    drawTopBand();
    y = 28;

    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor.apply(doc, ACCENT);
    doc.text("RAINMAKER", marginX, y);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Morning - Research concierge", marginX, y + 12);
    doc.text("#" + sid, pageW - marginX, y, { align: "right" });
    doc.text(updated, pageW - marginX, y + 12, { align: "right" });
    y += 36;

    doc.setFillColor.apply(doc, CARD);
    doc.setDrawColor(58, 74, 94);
    doc.setLineWidth(0.5);
    const cardTop = y;
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("RESEARCH QUESTION", marginX + 12, y);
    y += 14;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(14);
    doc.setTextColor(232, 237, 244);
    const promptLines = doc.splitTextToSize(prompt, maxW - 24);
    ensureSpace(promptLines.length * 18 + 40);
    doc.text(promptLines, marginX + 12, y);
    y += promptLines.length * 18 + 8;

    if (summary) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(10);
      doc.setTextColor(126, 200, 212);
      const sumLines = doc.splitTextToSize(summary, maxW - 24);
      doc.text(sumLines, marginX + 12, y);
      y += sumLines.length * 14 + 6;
    }

    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, BULL);
    doc.text(status, marginX + 12, y);
    doc.setFont("helvetica", "normal");
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Probabilistic - no performance guarantees", marginX + 52, y);
    y += 16;
    doc.roundedRect(marginX, cardTop, maxW, y - cardTop, 4, 4, "FD");
    y += 20;

    const sections = parseMarkdownSections(raw);
    if (!sections.length) {
      writeSectionTitle("Report");
      writeLines(bodyLines(raw), { size: 10 });
    } else {
      sections.forEach(function (sec) {
        if (sec.title) {
          writeSectionTitle(sec.title);
        }
        writeLines(bodyLines(sec.body), { size: 10, gap: 6 });
        y += 8;
      });
    }

    const artifacts = (detail && detail.artifacts) || [];
    const sources = artifacts.filter(function (a) {
      return a.kind === "snippet" || a.kind === "raw_doc" || a.kind === "attachment";
    });
    if (sources.length) {
      writeSectionTitle("Sources");
      sources.slice(0, 12).forEach(function (a) {
        const src = ((a.meta && a.meta.source) || "source").toString();
        writeLines([stripMarkdown(a.title || "source") + " (" + src + ")"], {
          size: 9,
          color: MUTED,
          gap: 2,
        });
      });
    }

    ensureSpace(24);
    doc.setDrawColor(58, 74, 94);
    doc.line(marginX, y, pageW - marginX, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor.apply(doc, MUTED);
    doc.text("Rainmaker Morning - thepokerninja.github.io/rainmaker-morning", marginX, y);

    doc.save(reportFilename(idea));
  }

  global.RMResearchPdf = { download, reportFilename };
})(
  typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : this
);
