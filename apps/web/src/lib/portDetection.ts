/**
 * Detects port numbers from terminal output text.
 *
 * Matches common dev-server output patterns like:
 * - "localhost:5173"
 * - "http://localhost:3000"
 * - "0.0.0.0:8080"
 * - "127.0.0.1:4321"
 * - "port 3000"
 * - "Port: 8080"
 * - "listening on :5173"
 */

const PORT_PATTERNS = [
  // URLs: http://localhost:PORT, http://127.0.0.1:PORT, http://0.0.0.0:PORT
  /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g,
  // Host:port without protocol
  /(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{2,5})/g,
  // "port 3000" / "Port: 8080" / "PORT=5173"
  /\bport[:\s=]+(\d{2,5})\b/gi,
  // "listening on :5173"
  /listening\s+on\s+:(\d{2,5})/gi,
];

const MIN_PORT = 1024;
const MAX_PORT = 65535;

function isValidPort(port: number): boolean {
  return Number.isFinite(port) && port >= MIN_PORT && port <= MAX_PORT;
}

/**
 * Extract unique port numbers from a chunk of terminal output text.
 */
export function detectPorts(text: string): number[] {
  const ports = new Set<number>();
  for (const pattern of PORT_PATTERNS) {
    // Reset lastIndex for global regexes
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const port = Number.parseInt(match[1]!, 10);
      if (isValidPort(port)) {
        ports.add(port);
      }
    }
  }
  return [...ports].toSorted((a, b) => a - b);
}
