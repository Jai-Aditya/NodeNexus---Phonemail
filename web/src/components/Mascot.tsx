// Pip, PhoneMail's pixel mascot: a carrier pigeon in the app's colours (indigo feathers, a
// lavender wing, marigold beak and feet) carrying a letter in its beak. Drawn from a character
// grid (one letter per pixel) as SVG rectangles, so it stays crisp at any size and needs no
// image file. It blinks now and then (not with reduced motion).

// Palette: letters in the grid -> colours.
const COLORS: Record<string, string> = {
  K: '#1F1C33', // outline, ink
  B: '#4B3FB0', // feathers, indigo
  D: '#3A2F95', // tail and shade, deep indigo
  L: '#8C82F2', // wing, lavender
  P: '#ECEAFB', // breast, pale lavender
  E: '#1F1C33', // eye
  W: '#FFFFFF', // eye shine; the letter's paper
  C: '#F4A3B4', // cheek
  Y: '#F2A33A', // beak, feet and the letter's folds, marigold
  O: '#C9791A', // lower beak, deep marigold
};

// 24 x 18. "." = empty.
const BODY = [
  '.........KKKK...........',
  '........KBBBBK..........',
  '.......KBBBBBBK.........',
  '.......KBBWEBBBK........',
  '.......KBBEEBBBK.KKKKKKK',
  '.......KBCBBBBBYYKYWWWYK',
  '......KBBBBBBBBOKKWYWYWK',
  '.....KBBBPPPPBBK.KWWYWWK',
  '..KK.KBBPPPPPPBK.KKKKKKK',
  '.KDDKBLLLLPPPPPK........',
  'KDDDBLLLLLLPPPPK........',
  '.KDDBBLLLLLLPPBK........',
  '..KKDBBLLLLBBBK.........',
  '....KDDBBBBBBK..........',
  '.....KKKKKKKK...........',
  '.......KYK.KYK..........',
  '......KYYK.KYYK.........',
  '........................',
];
// The eye closed (row 3 of the grid), for blinking.
const BLINK: Record<number, string> = {
  3: '.......KBBBBBBBK........',
};

function pixels(rows: string[]) {
  const out: { x: number; y: number; c: string }[] = [];
  rows.forEach((row, y) => [...row].forEach((ch, x) => { if (COLORS[ch]) out.push({ x, y, c: COLORS[ch] }); }));
  return out;
}

const OPEN = pixels(BODY);
const SHUT = pixels(BODY.map((r, i) => BLINK[i] ?? r));

export function Mascot({ size = 96, className = '', label }: { size?: number; className?: string; label?: string }) {
  const draw = (list: typeof OPEN, cls: string) => (
    <g className={cls}>
      {list.map((p) => <rect key={`${p.x}-${p.y}`} x={p.x} y={p.y} width={1.02} height={1.02} fill={p.c} />)}
    </g>
  );
  return (
    <svg className={`mascot ${className}`} width={size} height={size * 18 / 24} viewBox="0 0 24 18" shapeRendering="crispEdges"
      role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {draw(OPEN, 'mascot-open')}
      {draw(SHUT, 'mascot-shut')}
    </svg>
  );
}
