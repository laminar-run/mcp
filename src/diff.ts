/**
 * Simple line-by-line diff using LCS.
 * No external dependencies — good enough for workflow step sizes (< 500 lines).
 * Outputs a context-limited diff (3 lines of context around changes).
 */

const CONTEXT = 3;

function lcs(a: string[], b: string[]): string[] {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(0)
  );

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1] + 1
          : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  const result: string[] = [];
  let i = n,
    j = m;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[--i]);
      j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }
  return result;
}

interface DiffLine {
  type: "keep" | "add" | "del";
  text: string;
}

export function computeDiff(
  a: string,
  b: string,
  labelA = "current",
  labelB = "proposed"
): string {
  if (a === b) return "No differences found.";

  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const common = lcs(linesA, linesB);

  // Build full diff ops list
  const ops: DiffLine[] = [];
  let iA = 0,
    iB = 0,
    iC = 0;

  while (iA < linesA.length || iB < linesB.length) {
    if (iC < common.length) {
      while (iA < linesA.length && linesA[iA] !== common[iC]) {
        ops.push({ type: "del", text: linesA[iA++] });
      }
      while (iB < linesB.length && linesB[iB] !== common[iC]) {
        ops.push({ type: "add", text: linesB[iB++] });
      }
      ops.push({ type: "keep", text: common[iC] });
      iA++;
      iB++;
      iC++;
    } else {
      while (iA < linesA.length)
        ops.push({ type: "del", text: linesA[iA++] });
      while (iB < linesB.length)
        ops.push({ type: "add", text: linesB[iB++] });
    }
  }

  // Now emit only changes with CONTEXT lines of surrounding context.
  // Find indices of change lines, then include nearby keep lines.
  const changeIndices = new Set<number>();
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== "keep") {
      for (
        let j = Math.max(0, i - CONTEXT);
        j <= Math.min(ops.length - 1, i + CONTEXT);
        j++
      ) {
        changeIndices.add(j);
      }
    }
  }

  const out: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let lastEmitted = -2;

  for (let i = 0; i < ops.length; i++) {
    if (!changeIndices.has(i)) continue;

    if (i > lastEmitted + 1) {
      out.push("...");
    }

    const op = ops[i];
    if (op.type === "keep") out.push(`  ${op.text}`);
    else if (op.type === "del") out.push(`- ${op.text}`);
    else out.push(`+ ${op.text}`);

    lastEmitted = i;
  }

  const added = ops.filter((o) => o.type === "add").length;
  const removed = ops.filter((o) => o.type === "del").length;
  out.push("");
  out.push(`Summary: +${added} -${removed} lines changed`);
  return out.join("\n");
}
