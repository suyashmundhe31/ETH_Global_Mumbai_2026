// Deterministic wallet avatar: a mirrored 5×5 pattern in two hues taken from the address.

export const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export default function Avatar({ address, size = 30, className = "avatar" }: { address: string; size?: number; className?: string }) {
  const hex = address.toLowerCase().replace(/^0x/, "").padEnd(40, "0");
  const byte = (i: number) => parseInt(hex.slice((i * 2) % 40, (i * 2) % 40 + 2), 16) || 0;
  const hue = Math.round((byte(0) / 255) * 360);
  const hue2 = (hue + 40 + Math.round((byte(1) / 255) * 80)) % 360;
  const cells: { x: number; y: number }[] = [];
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      if (byte(2 + y * 3 + x) % 2 === 0) {
        cells.push({ x, y });
        if (x < 2) cells.push({ x: 4 - x, y });
      }
    }
  }
  return (
    <svg viewBox="0 0 5 5" width={size} height={size} className={className} aria-hidden="true" shapeRendering="crispEdges">
      <rect width="5" height="5" fill={`hsl(${hue2} 45% 18%)`} />
      {cells.map((c) => (
        <rect key={`${c.x}-${c.y}`} x={c.x} y={c.y} width="1" height="1" fill={`hsl(${hue} 70% 62%)`} />
      ))}
    </svg>
  );
}
