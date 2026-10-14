import * as vscode from "vscode";

export interface RunningOperation {
  readonly name: string;
  readonly controller: AbortController;
}

/** Runs one long operation at a time, with a cancellable progress notification. */
export class OperationRunner implements vscode.Disposable {
  private active: RunningOperation | undefined;
  private readonly emitter = new vscode.EventEmitter<boolean>();
  readonly onDidChangeBusy = this.emitter.event;

  get current(): RunningOperation | undefined {
    return this.active;
  }

  cancel(): boolean {
    if (!this.active) {
      return false;
    }
    this.active.controller.abort();
    return true;
  }

  async run<T>(
    name: string,
    task: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T | undefined> {
    if (this.active) {
      void vscode.window.showWarningMessage(
        `Manifest Lens is busy: ${this.active.name}. Wait for it to finish or run "Manifest Lens: Cancel active analysis or installation".`
      );
      return undefined;
    }
    const controller = new AbortController();
    this.active = { controller, name };
    this.emitter.fire(true);
    try {
      return await vscode.window.withProgress(
        {
          cancellable: true,
          location: vscode.ProgressLocation.Notification,
          title: `Manifest Lens: ${name}`,
        },
        async (progress, token) => {
          token.onCancellationRequested(() => {
            controller.abort();
          });
          return await task(controller.signal, (message) => {
            progress.report({ message });
          });
        }
      );
    } finally {
      this.active = undefined;
      this.emitter.fire(false);
    }
  }

  dispose(): void {
    this.cancel();
    this.emitter.dispose();
  }
}
