import type { Logger } from 'pino';
import { runWithLogContext } from './log-context';

/** Executa `task` a cada `intervalMs` sem sobreposição; `stop` espera o ciclo em andamento. */
export class PeriodicTask {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(
    private readonly name: string,
    private readonly intervalMs: number,
    private readonly task: () => Promise<unknown>,
    private readonly logger: Logger,
  ) {}

  start(): void {
    this.stopped = false;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.tick().finally(() => {
        this.running = undefined;
        this.schedule();
      });
    }, this.intervalMs);
  }

  private async tick(): Promise<void> {
    try {
      await runWithLogContext({ task: this.name }, this.task);
    } catch (error) {
      this.logger.error({ err: error, task: this.name }, 'periodic task failed');
    }
  }
}
