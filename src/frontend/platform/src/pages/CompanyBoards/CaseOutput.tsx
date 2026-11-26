import { savedCaseTable } from "./caseTable";

export function CaseGrid({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  if (!head) return null;
  return (
    <div style={{ maxWidth: "100%", overflowX: "auto" }}>
      <table className="table table-vcenter">
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((r, i) => (
            <tr key={i}>
              {r.map((cell, j) => (
                <td key={j} style={{ whiteSpace: "pre-line" }}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CaseOutput({ fields, empty }: { fields?: Record<string, string>; empty: string }) {
  const rows = savedCaseTable(fields?.sampleTable);
  return (
    <>
      {rows.length ? <CaseGrid rows={rows} /> : null}
      {fields?.output ? (
        <p className="sample-note" style={{ whiteSpace: "pre-line", overflowWrap: "anywhere" }}>
          {fields.output}
        </p>
      ) : (
        !rows.length && <p className="sample-note">{empty}</p>
      )}
    </>
  );
}
