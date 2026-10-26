export function Logo({ size = 40, className = '' }: { size?: number; className?: string }) {
  return <img src="/logo.png" width={size} height={size} alt="Wazzupp" className={className} style={{ width: size, height: size, objectFit: 'contain', flex: 'none' }} draggable={false} />;
}
