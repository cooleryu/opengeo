import OpenGeoApp from '@/components/geo/OpenGeoApp';
import { redirect } from 'next/navigation';
import { readProjectCatalog } from '@/lib/geo/project-data';

export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  const params = await searchParams;
  if (!params.project && readProjectCatalog().ids.length === 0)
    redirect('/new');
  return <OpenGeoApp />;
}
