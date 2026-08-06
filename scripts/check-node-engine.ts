import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Node's own release policy - not a snapshot of Vercel's current lineup -
// is what makes this check durable: every even major becomes an LTS line
// every October, every odd major is Current-only and never gets LTS status,
// ever. Vercel only deploys LTS majors, so "is it even" stays correct as
// the supported set moves from 20/22/24 to 22/24/26 and beyond, without
// this script needing an update each time.
//
// Exported (not just used inline) so the exact logic is unit-testable
// without needing a real package.json on disk - see check-node-engine.test.ts.
// Returns null when the range is fine, or an error message when it isn't.
export function checkEvenLtsMajor(nodeRange: string | undefined): string | null {
  if (!nodeRange) {
    return "package.json is missing engines.node - Vercel needs an explicit Node major version.";
  }

  const match = /(\d+)/.exec(nodeRange);
  const major = match ? Number(match[1]) : null;

  if (major === null) {
    return `Could not parse a major version number out of engines.node: "${nodeRange}"`;
  }

  if (major % 2 !== 0) {
    return (
      `package.json's engines.node ("${nodeRange}") names Node ${major}, an odd-numbered release. ` +
      `Odd Node majors are always "Current," never LTS, and Vercel only deploys even-numbered LTS ` +
      `releases (20, 22, 24, ...) - this exact mismatch broke a real deploy once already (see STATE.md). ` +
      `Set engines.node to an even major - whichever is the currently active LTS line - and update ` +
      `.nvmrc to match.`
    );
  }

  return null;
}

function main(): void {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
    engines?: { node?: string };
  };
  const nodeRange = pkg.engines?.node;
  const error = checkEvenLtsMajor(nodeRange);

  if (error) {
    console.error(error);
    process.exit(1);
  }

  console.log(`engines.node ("${nodeRange}") names an even-numbered LTS major - OK for Vercel.`);
}

// Only run the file-reading, process-exiting side effects when this file is
// the entry script (`tsx scripts/check-node-engine.ts`), not when it's
// imported for testing.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
