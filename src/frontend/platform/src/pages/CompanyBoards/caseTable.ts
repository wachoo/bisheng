/** Workbook clipboard text uses tab-separated cells and CSV-style quotes for multiline values. */
export function parseCasePaste(text: string): string[][] {
  if (!text.trim()) return [];
  const matrix: string[][] = [];
  let row: string[] = [],
    cell = "",
    quoted = false,
    closed = false;
  const finish = () => {
    row.push(cell);
    cell = "";
    closed = false;
  };
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n$/, "");
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quoted) {
      if (c !== '"') cell += c;
      else if (clean[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
        closed = true;
      }
    } else if (c === "\t") finish();
    else if (c === "\n") {
      finish();
      matrix.push(row);
      row = [];
    } else if (c === '"' && !cell && !closed) quoted = true;
    else if (closed) throw new Error("quote");
    else cell += c;
  }
  if (quoted) throw new Error("quote");
  finish();
  matrix.push(row);
  return matrix;
}

export function caseTableError(grid: string[][]): string | null {
  if (!grid.length) return null;
  const [head, ...rows] = grid;
  if (!head.length || head.length > 8 || !rows.length || rows.length > 20) return "size";
  if (head.some((cell) => !cell.trim() || [...cell].length > 64)) return "head";
  if (rows.some((r) => r.length !== head.length)) return "width";
  if (rows.some((r) => r.every((c) => !c.trim()) || r.some((c) => [...c].length > 256))) return "cell";
  if (new TextEncoder().encode(JSON.stringify(grid)).length > 24000) return "bytes";
  return null;
}

export function savedCaseTable(value?: string): string[][] {
  if (!value) return [];
  try {
    const grid: unknown = JSON.parse(value);
    if (
      !Array.isArray(grid) ||
      !grid.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))
    )
      return [];
    return caseTableError(grid) ? [] : grid;
  } catch {
    return [];
  }
}

export function caseTableClipboard(grid: string[][]): string {
  const escape = (c: string) => (/[\t\n\r"]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c);
  return grid.map((row) => row.map(escape).join("\t")).join("\n");
}
