// `saw wallet send --amount 1.5 --recipient <addr> --json` → { words: [wallet, send], flags: {amount, recipient}, json: true }
export interface Parsed {
  words: string[];
  positional: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
}

const camel = (k: string) => k.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

export function parseArgv(argv: string[]): Parsed {
  const words: string[] = [];
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  let json = false;
  let seenFlag = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") {
      json = true;
      continue;
    }
    if (a.startsWith("--")) {
      seenFlag = true;
      const eq = a.indexOf("=");
      if (eq > 0) {
        flags[camel(a.slice(2, eq))] = a.slice(eq + 1);
        continue;
      }
      const key = camel(a.slice(2));
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (seenFlag) positional.push(a);
    else words.push(a);
  }
  return { words, positional, flags, json };
}
