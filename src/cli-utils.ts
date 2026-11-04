export function parseFlags(args: string[], booleans: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) throw new Error(`argument inattendu : ${args[i]}`);
    const key = args[i].slice(2);
    if (booleans.includes(key)) {
      out[key] = "true";
      continue;
    }
    const val = args[i + 1];
    if (val === undefined || val.startsWith("--")) throw new Error(`--${key} attend une valeur`);
    out[key] = val;
    i++;
  }
  return out;
}
