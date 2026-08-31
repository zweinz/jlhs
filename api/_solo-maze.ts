export const SOLO_MAZE_SIZE = 41;

export function deterministicMazeSvg(seedText: string) {
  const size = SOLO_MAZE_SIZE;
  let seed = [...seedText].reduce((value, character) => (value * 33 + character.charCodeAt(0)) >>> 0, 2166136261);
  const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 0x1_0000_0000; };
  const visited = Array.from({ length: size }, () => Array(size).fill(false));
  const openings = new Set<string>();
  const stack: Array<[number, number]> = [[0, 0]];
  visited[0][0] = true;
  while (stack.length) {
    const [x, y] = stack[stack.length - 1];
    const neighbors = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]]
      .filter(([nx, ny]) => nx >= 0 && nx < size && ny >= 0 && ny < size && !visited[ny][nx]);
    if (!neighbors.length) { stack.pop(); continue; }
    const [nx, ny] = neighbors[Math.floor(random() * neighbors.length)];
    openings.add(`${x},${y}:${nx},${ny}`);
    openings.add(`${nx},${ny}:${x},${y}`);
    visited[ny][nx] = true;
    stack.push([nx, ny]);
  }
  const cell = 10;
  const lines: string[] = [];
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) {
    if (y === 0 && x !== 0) lines.push(`<path d="M${x * cell} ${y * cell}h${cell}"/>`);
    if (x === 0) lines.push(`<path d="M${x * cell} ${y * cell}v${cell}"/>`);
    if (!openings.has(`${x},${y}:${x + 1},${y}`)) lines.push(`<path d="M${(x + 1) * cell} ${y * cell}v${cell}"/>`);
    if (!openings.has(`${x},${y}:${x},${y + 1}`) && !(y === size - 1 && x === size - 1)) lines.push(`<path d="M${x * cell} ${(y + 1) * cell}h${cell}"/>`);
  }
  const extent = size * cell;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${extent}" height="${extent}" viewBox="0 0 ${extent} ${extent}" role="img" aria-label="Challenging ${size} by ${size} solvable maze"><rect width="100%" height="100%" fill="white"/><g fill="none" stroke="#17222d" stroke-width="1.4">${lines.join('')}</g><text x="2" y="9" font-size="7" font-weight="700">START</text><text x="${extent - 19}" y="${extent - 3}" font-size="7" font-weight="700">END</text></svg>`;
}
