/* global window */
(function (root) {
  const SEP = ';';

function escape(v) {
  if (v == null) return '';

  if (Array.isArray(v)) {
    // Join array items with newlines for nicer CSV display
    // and escape quotes inside each item
    return v.map(String).join('\n').replace(/"/g, '""');
  }

  if (typeof v === 'object') {
    // For plain objects, keep JSON representation
    return JSON.stringify(v).replace(/"/g, '""');
  }

  return String(v).replace(/"/g, '""');
}
  root.rowsToCsv = rows => {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    const lines = [
      headers.join(SEP),
      ...rows.map(r => headers.map(h => `"${escape(r[h])}"`).join(SEP))
    ];
    return lines.join('\r\n');
  };

    function stripBOM(s) {
    return s && s.charCodeAt(0) === 0xFEFF ? s.slice(1) : s;
  }

  function sniffDelimiter(line) {
    if (!line) return ';';
    let inQ = false, semi = 0, comma = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') inQ = !inQ;
      else if (!inQ && ch === ';') semi++;
      else if (!inQ && ch === ',') comma++;
    }
    return comma > semi ? ',' : ';';
  }

  root.parseCsv = (text, sep) => {
    text = stripBOM(text || '');
    if (!text) return [];

    if (!sep) {
      const firstLine = text.split(/\r?\n/).find(l => l.trim());
      sep = sniffDelimiter(firstLine);
    }

    const out = [];
    let headers = null;
    let row = [], field = '', inQ = false;

    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => {
    if (!headers) {
    headers = row.map(h => (h || '').replace(/\uFEFF/g, '').trim());
    } else {
        const obj = {};
        headers.forEach((h, i) => obj[h] = row[i] ?? '');
        out.push(obj);
      }
      row = [];
    };

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQ = false;
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === sep) pushField();
        else if (ch === '\r') {
          if (text[i + 1] === '\n') i++;
          pushField(); pushRow();
        } else if (ch === '\n') {
          pushField(); pushRow();
        } else {
          field += ch;
        }
      }
    }
    // flush last field/row
    pushField();
    if (row.length) pushRow();

    return out;
  };
})(typeof window === 'undefined' ? globalThis : window);
