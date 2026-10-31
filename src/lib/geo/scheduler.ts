import { geoRuntime, listTasks, newEvent, taskIsBusy, updateTask } from './store';
import { startMonitor } from './monitor';
import { GEO_PROJECT_IDS, withGeoProject } from './projects';
import { tickResearchSchedules } from './research-tracking';

export async function tickGeoScheduler(): Promise<void> {
  if (geoRuntime.ticking) return;
  geoRuntime.ticking = true;
  try {
    const now = Date.now();
    await tickResearchSchedules();
    for (const projectId of GEO_PROJECT_IDS) await withGeoProject(projectId, async () => {
      for (const task of listTasks()) {
        if (task.status !== 'monitoring' || !task.monitor.enabled || !task.monitor.nextRunAt || task.monitor.remaining <= 0 || new Date(task.monitor.nextRunAt).getTime() > now || taskIsBusy(task.id)) continue;
        try { startMonitor(task.id, task.monitor.mode, true); }
        catch (error) {
          const message = error instanceof Error ? error.message : '每日观察无法启动。';
          // A live run in this project is short-lived; leave its slot pending.
          if (message.includes('另一条真实观察')) continue;
          updateTask(task.id, t => { t.status = 'failed'; t.error = message; t.monitor.enabled = false; t.monitor.nextRunAt = null; t.events.push(newEvent('每日观察需要处理', message, 'attention')); });
        }
      }
    });
  } finally { geoRuntime.ticking = false; }
}

export function startGeoScheduler(): void {
  if (geoRuntime.timer && geoRuntime.schedulerVersion === 3) return;
  if (geoRuntime.timer) clearInterval(geoRuntime.timer);
  // Initializing storage also recovers a task interrupted by a previous process.
  for (const projectId of GEO_PROJECT_IDS) withGeoProject(projectId, () => listTasks());
  geoRuntime.schedulerVersion = 3;
  geoRuntime.schedulerRunning = true;
  geoRuntime.timer = setInterval(() => { void tickGeoScheduler().catch(error => console.error('[OpenGEO scheduler]', error instanceof Error ? error.message : error)); }, 30000);
  geoRuntime.timer.unref?.();
  void tickGeoScheduler().catch(error => console.error('[OpenGEO scheduler]', error instanceof Error ? error.message : error));
}
