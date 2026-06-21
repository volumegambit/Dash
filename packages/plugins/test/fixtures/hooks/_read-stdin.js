// Shared helper for fixture hook scripts. Reads all of stdin and resolves the
// parsed JSON (or {} when empty / unparseable). ESM module (the nearest
// package.json sets "type": "module").
export function readStdin() {
  return new Promise((resolve) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}
