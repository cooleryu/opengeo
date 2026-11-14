import Image from 'next/image';

/** Static OpenGEO rounded-square primary brand mark rendered from the 60px asset. */
export default function OpenGeoBrandMark({
  size = 24,
  className = 'og-brand-mark',
}: {
  size?: number;
  className?: string;
}) {
  return (
    <Image
      src="/brand/opengeo-mark-60.png"
      width={size}
      height={size}
      unoptimized
      alt=""
      aria-hidden="true"
      className={className}
    />
  );
}
