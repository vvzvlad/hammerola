// A CSV document's rows, for the table DocumentView.jsx draws of it.

/**
 * The rows of a CSV text, each an array of its fields, as RFC 4180 writes
 * them: fields split by commas, rows by LF or CRLF; a field that starts with a
 * double quote runs to the closing one and may hold commas, line breaks and
 * `""` for a quote. A quote inside an unquoted field is kept as a character.
 * The line break after the last row ends that row rather than starting an
 * empty one; an empty line inside is a row of one empty field.
 */
export function parseCsv(text) {
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
    } else if (c === ',') {
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
  return rows;
}
