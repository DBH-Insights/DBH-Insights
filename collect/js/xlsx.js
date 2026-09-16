// Multi-sheet .xlsx writer with the inventory workbook formatting:
//
//   Header row     Verdana 9pt bold, white on solid black, left aligned
//   Body text      Verdana 9pt
//   Integers       #,##0, right aligned        Decimals  #,##0.00, right aligned
//   Timestamps     real Excel dates, yyyy/mm/dd hh:mm:ss (UTC, as vCenter reports)
//   Booleans       the words True / False
//   Freeze panes   first row and first column (pane at B2)
//   AutoFilter     whole range, header included
//
// No dependencies: a workbook is a zip of XML parts, written here with the "stored" method.

const Xlsx = (() => {
  const SHEET_ORDER = [
    "vInfo", "vCPU", "vMemory", "vDisk", "vPartition", "vNetwork", "vCD", "vUSB", "vSnapshot", "vTools",
    "vSource", "vRP", "vCluster", "vHost", "vHBA", "vNIC", "vSwitch", "vPort", "dvSwitch", "dvPort",
    "vSC_VMK", "vDatastore", "vMultiPath", "vLicense", "vFileInfo", "vHealth", "vMetaData",
  ];

  const STYLE = { header: 1, text: 2, integer: 3, decimal: 4, date: 5 };

  const encoder = new TextEncoder();

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /** Zip archive, stored (uncompressed), UTF-8 names. */
  function zip(files) {
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const file of files) {
      const name = encoder.encode(file.name);
      const data = encoder.encode(file.data);
      const crc = crc32(data);

      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true);
      local.setUint16(8, 0, true);
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, data.length, true);
      local.setUint32(22, data.length, true);
      local.setUint16(26, name.length, true);
      local.setUint16(28, 0, true);
      parts.push(new Uint8Array(local.buffer), name, data);

      const entry = new DataView(new ArrayBuffer(46));
      entry.setUint32(0, 0x02014b50, true);
      entry.setUint16(4, 20, true);
      entry.setUint16(6, 20, true);
      entry.setUint16(8, 0x0800, true);
      entry.setUint16(10, 0, true);
      entry.setUint16(12, time, true);
      entry.setUint16(14, date, true);
      entry.setUint32(16, crc, true);
      entry.setUint32(20, data.length, true);
      entry.setUint32(24, data.length, true);
      entry.setUint16(28, name.length, true);
      entry.setUint32(42, offset, true);
      central.push(new Uint8Array(entry.buffer), name);

      offset += 30 + name.length + data.length;
    }

    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
  }

  // Control characters are not allowed in XML 1.0 and would corrupt the workbook.
  const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

  function esc(value) {
    return String(value)
      .replace(INVALID_XML, "")
      .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  }

  function columnLetter(index) {
    let n = index + 1;
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

  function excelDate(text) {
    if (!TIMESTAMP.test(text)) return null;
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms / 86400000 + 25569;
  }

  /** A column is formatted uniformly, decided from all of its values. */
  function columnFormat(table, index) {
    const values = table.rows.map((r) => r[index]).filter((v) => v !== null && v !== undefined && v !== "");
    const kind = table.columns[index].kind;
    if (kind === "number") {
      return values.every((v) => typeof v !== "number" || Number.isInteger(v)) ? "integer" : "decimal";
    }
    if (kind === "text" && values.length && values.every((v) => typeof v === "string" && excelDate(v) !== null)) {
      return "date";
    }
    return "text";
  }

  function inlineString(ref, style, text) {
    return `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
  }

  function sheetXml(table) {
    const letters = table.columns.map((_, i) => columnLetter(i));
    const formats = table.columns.map((_, i) => columnFormat(table, i));
    const lastRef = `${letters[letters.length - 1] ?? "A"}${table.rows.length + 1}`;

    const widths = table.columns.map((column, i) => {
      let width = column.label.length;
      for (const row of table.rows.slice(0, 2000)) {
        const v = row[i];
        const len = v === null || v === undefined ? 0 : typeof v === "boolean" ? 5 : formats[i] === "date" ? 19 : String(v).length;
        if (len > width) width = len;
      }
      return Math.min(60, width + 2);
    });

    const out = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">',
      `<dimension ref="A1:${lastRef}"/>`,
      '<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"/>' +
        '<selection pane="topRight"/><selection pane="bottomLeft"/><selection pane="bottomRight" activeCell="B2" sqref="B2"/></sheetView></sheetViews>',
      '<sheetFormatPr defaultRowHeight="12"/>',
      `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`,
      "<sheetData>",
      `<row r="1">${table.columns.map((c, i) => inlineString(`${letters[i]}1`, STYLE.header, c.label)).join("")}</row>`,
    ];

    table.rows.forEach((row, r) => {
      const n = r + 2;
      const cells = row.map((v, i) => {
        const ref = `${letters[i]}${n}`;
        if (v === null || v === undefined || v === "") return `<c r="${ref}" s="${STYLE.text}"/>`;
        if (typeof v === "boolean") return inlineString(ref, STYLE.text, v ? "True" : "False");
        if (typeof v === "number") {
          if (!Number.isFinite(v)) return `<c r="${ref}" s="${STYLE.text}"/>`;
          return `<c r="${ref}" s="${formats[i] === "integer" ? STYLE.integer : STYLE.decimal}"><v>${v}</v></c>`;
        }
        if (formats[i] === "date") return `<c r="${ref}" s="${STYLE.date}"><v>${excelDate(v)}</v></c>`;
        return inlineString(ref, STYLE.text, v);
      });
      out.push(`<row r="${n}">${cells.join("")}</row>`);
    });

    out.push("</sheetData>", `<autoFilter ref="A1:${lastRef}"/>`, "</worksheet>");
    return out.join("");
  }

  const STYLES_XML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd hh:mm:ss"/></numFmts>' +
    '<fonts count="2">' +
    '<font><sz val="9"/><color rgb="FF000000"/><name val="Verdana"/><family val="2"/></font>' +
    '<font><b/><sz val="9"/><color rgb="FFFFFFFF"/><name val="Verdana"/><family val="2"/></font>' +
    "</fonts>" +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
    '<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="6">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left"/></xf>' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>' +
    '<xf numFmtId="4" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="right"/></xf>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/>' +
    "</cellXfs>" +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    "</styleSheet>";

  /** Build a workbook Blob from tables ({name, columns: [{label, kind}], rows}). */
  function workbook(tables) {
    const ordered = [
      ...SHEET_ORDER.map((name) => tables.find((t) => t.name === name)).filter(Boolean),
      ...tables.filter((t) => !SHEET_ORDER.includes(t.name)),
    ];

    const sheetName = (name) => esc(name.slice(0, 31));
    const files = [
      {
        name: "[Content_Types].xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
          '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
          '<Default Extension="xml" ContentType="application/xml"/>' +
          '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
          '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
          ordered
            .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
            .join("") +
          "</Types>",
      },
      {
        name: "_rels/.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
          "</Relationships>",
      },
      {
        name: "xl/workbook.xml",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
          '<bookViews><workbookView/></bookViews><sheets>' +
          ordered.map((t, i) => `<sheet name="${sheetName(t.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("") +
          "</sheets><definedNames>" +
          ordered
            .map((t, i) => {
              const last = `$${columnLetter(Math.max(0, t.columns.length - 1))}$${t.rows.length + 1}`;
              return `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${sheetName(t.name)}'!$A$1:${last}</definedName>`;
            })
            .join("") +
          "</definedNames></workbook>",
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data:
          '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
          '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
          ordered
            .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
            .join("") +
          `<Relationship Id="rId${ordered.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
          "</Relationships>",
      },
      { name: "xl/styles.xml", data: STYLES_XML },
      ...ordered.map((t, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(t) })),
    ];
    return zip(files);
  }

  return { workbook };
})();
