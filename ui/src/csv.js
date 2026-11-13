// A CSV document's rows, for the table DocumentView.jsx draws of it.

/**
 * The text of a CSV file's bytes: UTF-8, or windows-1251, the Cyrillic code
 * page older parts lists were saved in, when they are not valid UTF-8.
 */
export function decodeCsv(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1251').decode(bytes);
  }
}

/**
 * The field delimiter of a CSV text: whichever of a comma, a semicolon and a
 * tab its first line holds most of outside quotes, the first of them in that
 * order on a tie, a comma when it holds none.
 */
export function csvDelimiter(text) {
  const counts = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const c of text) {
    if (c === '"') quoted = !quoted;
    else if (quoted) continue;
    else if (c === '\n' || c === '\r') break;
    else if (c in counts) counts[c] += 1;
  }
  return Object.keys(counts).reduce((best, one) => (counts[one] > counts[best] ? one : best));
}

/**
 * The rows of a CSV text, each an array of its fields, as RFC 4180 writes
 * them: fields split by the delimiter (`csvDelimiter`), rows by LF or CRLF; a
 * field that starts with a double quote runs to the closing one and may hold
 * delimiters, line breaks and `""` for a quote. A quote inside an unquoted
 * field is kept as a character. The line break after the last row ends that
 * row rather than starting an empty one; an empty line inside is a row of one
 * empty field. Eagle's parts list ends every line with the delimiter: a last
 * field empty in every row of several fields is that ending, not a column, and
 * is dropped.
 */
export function parseCsv(text) {
  const delimiter = csvDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else quoted = false;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started) {
    row.push(field);
    rows.push(row);
  }
  if (rows.length && rows.every((r) => r.length > 1 && r[r.length - 1] === '')) {
    for (const r of rows) r.pop();
  }
  return rows;
}
