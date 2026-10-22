export const register = async () => {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const fs = await import('node:fs');
    const path = await import('node:path');
    fs.mkdirSync(path.join(process.env.DATA_DIR || process.cwd(), 'data'), { recursive: true });
    try {
      console.log('Running database migrations...');
      await import('./lib/db/migrate');
      console.log('Database migrations completed successfully');
    } catch (error) {
      console.error('Failed to run database migrations:', error);
    }

    await import('./lib/config/index');
    const { startGeoScheduler } = await import('./lib/geo/scheduler');
    startGeoScheduler();
  }
};
