import Image from 'next/image';
import { SiGoogle, SiOpenai } from '@icons-pack/react-simple-icons';
import type { ResearchEngine } from '@/lib/geo/research-types';

/** Local brand assets; their order is defined by RESEARCH_ENGINES. */
export default function ResearchEngineIcon({
  engine,
}: {
  engine: ResearchEngine;
}) {
  if (engine === 'chatgpt') return <SiOpenai size={21} aria-hidden="true" />;
  if (engine === 'google')
    return <SiGoogle size={20} color="#4285f4" aria-hidden="true" />;
  return (
    <Image src={`/platforms/${engine}.svg`} width={22} height={22} alt="" />
  );
}
