function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildTask(task) {
  return {
    id: task.id,
    file: task.file,
    fileRecordId: task.fileRecordId,
    userId: task.userId,
    options: task.options,
    status: "queued",
    retries: 0,
    maxRetries: Number(task.maxRetries ?? 3),
    error: "",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

export class UploadQueue {
  constructor(options = {}) {
    this.concurrency = Number(options.concurrency ?? 3);
    this.maxRetries = Number(options.maxRetries ?? 3);
    this.processor = options.processor;
    this.onTaskUpdate = options.onTaskUpdate ?? (() => {});
    this.onSnapshot = options.onSnapshot ?? (() => {});

    this.waiting = [];
    this.running = new Map();
    this.finished = new Map();
    this.isPaused = false;
  }

  addTasks(tasks) {
    const normalized = tasks.map((task) =>
      buildTask({ ...task, maxRetries: task.maxRetries ?? this.maxRetries })
    );
    normalized.forEach((task) => {
      this.waiting.push(task);
      this.onTaskUpdate(task);
    });
    this.emitSnapshot();
    this.pump();
    return normalized.map((task) => task.id);
  }

  pause() {
    this.isPaused = true;
    this.emitSnapshot();
  }

  resume() {
    this.isPaused = false;
    this.emitSnapshot();
    this.pump();
  }

  cancelQueued(taskId) {
    const idx = this.waiting.findIndex((task) => task.id === taskId);
    if (idx < 0) return false;
    const [task] = this.waiting.splice(idx, 1);
    const cancelled = {
      ...task,
      status: "failed",
      error: "Cancelled by user",
      updatedAt: Date.now(),
    };
    this.finished.set(cancelled.id, cancelled);
    this.onTaskUpdate(cancelled);
    this.emitSnapshot();
    return true;
  }

  clearFinished() {
    this.finished.clear();
    this.emitSnapshot();
  }

  snapshot() {
    const allFinished = Array.from(this.finished.values());
    return {
      queued: this.waiting.length,
      processing: this.running.size,
      completed: allFinished.filter((task) => task.status === "completed").length,
      failed: allFinished.filter((task) => task.status === "failed").length,
      total: this.waiting.length + this.running.size + allFinished.length,
      paused: this.isPaused,
    };
  }

  emitSnapshot() {
    this.onSnapshot(this.snapshot());
  }

  pump() {
    if (this.isPaused) return;
    while (this.running.size < this.concurrency && this.waiting.length > 0) {
      const task = this.waiting.shift();
      this.runTask(task);
    }
    this.emitSnapshot();
  }

  async runTask(task) {
    const processingTask = {
      ...task,
      status: "processing",
      updatedAt: Date.now(),
    };
    this.running.set(processingTask.id, processingTask);
    this.onTaskUpdate(processingTask);
    this.emitSnapshot();

    try {
      if (typeof this.processor !== "function") {
        throw new Error("Queue processor is not configured.");
      }
      await this.processor(processingTask);

      const completed = {
        ...processingTask,
        status: "completed",
        updatedAt: Date.now(),
      };
      this.running.delete(processingTask.id);
      this.finished.set(completed.id, completed);
      this.onTaskUpdate(completed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "Unknown error");
      const retries = processingTask.retries + 1;

      this.running.delete(processingTask.id);

      if (retries <= processingTask.maxRetries) {
        const retryTask = {
          ...processingTask,
          status: "queued",
          retries,
          error: message,
          updatedAt: Date.now(),
        };
        this.onTaskUpdate(retryTask);
        await sleep(Math.min(2000, retries * 500));
        this.waiting.push(retryTask);
      } else {
        const failed = {
          ...processingTask,
          status: "failed",
          retries,
          error: message,
          updatedAt: Date.now(),
        };
        this.finished.set(failed.id, failed);
        this.onTaskUpdate(failed);
      }
    } finally {
      this.emitSnapshot();
      this.pump();
    }
  }
}

