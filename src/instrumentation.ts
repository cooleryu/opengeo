export const register = async () => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(process.env.DATA_DIR || process.cwd(), 'data'), { recursive: true });
    const { startGeoScheduler } = await import('./lib/geo/scheduler');
    startGeoScheduler();
  }
};
