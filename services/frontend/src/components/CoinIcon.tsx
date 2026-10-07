export function CoinIcon({ coinId, image, size = 24 }: { coinId: string; image?: string | null; size?: number }) {
  if (image) return <img src={image} alt="" width={size} height={size} className="rounded-full" />;
  return (
    <span className="inline-grid shrink-0 place-items-center rounded-full bg-surface-2 text-[10px] font-semibold uppercase text-muted" style={{ width: size, height: size }}>
      {coinId.slice(0, 3)}
    </span>
  );
}
