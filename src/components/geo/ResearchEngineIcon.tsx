import { SiGoogle, SiOpenai } from '@icons-pack/react-simple-icons';
import type { ResearchEngine } from '@/lib/geo/research-types';

/** Local brand assets; their order is defined by RESEARCH_ENGINES. */
export default function ResearchEngineIcon({
  engine,
}: {
  engine: ResearchEngine;
}) {
  if (engine === 'chatgpt') return <SiOpenai size={21} aria-hidden="true" />;
  return <SiGoogle size={20} color="#4285f4" aria-hidden="true" />;
}
