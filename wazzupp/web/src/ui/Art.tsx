/** Original illustrations (line art with green fills) for empty states and onboarding sheets. */
const INK = '#102A24';
export function CommunityArt({ size = 220 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.88} viewBox="0 0 260 228" role="img" aria-label="People, pencil, apple and calculator" fill="none" stroke={INK} strokeWidth="3" strokeLinejoin="round" strokeLinecap="round">
      <rect x="14" y="26" width="232" height="188" rx="26" fill="#E6FADB" />
      <path d="M26 26h86a14 14 0 0 1 14 14v52a14 14 0 0 1-14 14H88l-16 14v-14H26a12 12 0 0 1-12-12V38a12 12 0 0 1 12-12z" fill="#E6FADB" />
      <circle cx="52" cy="54" r="9" /><circle cx="70" cy="48" r="10" /><circle cx="88" cy="54" r="9" />
      <path d="M38 80c0-8 6-12 14-12M102 80c0-8-6-12-14-12M54 82c0-9 7-14 16-14s16 5 16 14z" />
      <path d="M130 70l66-34 22 12-18 42z" fill="#2ED36B" /><path d="M150 62l50-24M156 74l48-24M196 36l22 12" /><path d="M218 48l-6-28-18 10z" fill="#43D17A" />
      <path d="M40 150c-10-6-12-20 0-26 8-4 18 2 20 8 6-14 28-14 36 0 6 12-2 40-18 52-8 6-14 4-18 2-8 4-14 4-22-4-10-10-10-24 2-32z" fill="#AEEA6A" />
      <path d="M62 126l4-14 14 4" fill="#2ED36B" />
      <rect x="120" y="110" width="104" height="94" rx="26" fill="#10D39B" />
      <path d="M172 112v92M120 160h104" /><path d="M136 134h24M184 134h28M198 120v28M140 176l20 20M160 176l-20 20" />
      <circle cx="110" cy="168" r="25" fill="#fff" /><path d="M98 162h24M98 174h24" />
    </svg>
  );
}
export function ChannelArt({ size = 230 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.62} viewBox="0 0 260 160" role="img" aria-label="Broadcast" fill="none" stroke={INK} strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M62 22c-22 26-22 90 0 116" stroke={INK} fill="none" /><path d="M52 14c-30 34-30 108 0 132" />
      <path d="M198 22c22 26 22 90 0 116" /><path d="M208 14c30 34 30 108 0 132" />
      <path d="M62 22c-22 26-22 90 0 116" strokeWidth="9" stroke="#E6FADB" /><path d="M198 22c22 26 22 90 0 116" strokeWidth="9" stroke="#E6FADB" />
      <path d="M130 14c-34 0-60 24-60 54s26 54 60 54c8 0 15-1 22-4l-12 22 26-14c14-12 24-30 24-58 0-30-26-54-60-54z" fill="#2ED36B" />
      <path d="M118 52c-10 10-10 26 0 36M142 52c10 10 10 26 0 36" strokeWidth="3" /><circle cx="130" cy="70" r="6" strokeWidth="3" />
    </svg>
  );
}
