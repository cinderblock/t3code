type GoToNextWaitingThread = () => void;

let registeredHandler: GoToNextWaitingThread | null = null;

export function registerGoToNextWaitingThread(handler: GoToNextWaitingThread): () => void {
  registeredHandler = handler;
  return () => {
    if (registeredHandler === handler) registeredHandler = null;
  };
}

/** Thread status lives in the sidebar; with none mounted, the send just stays put. */
export function goToNextWaitingThread(): void {
  registeredHandler?.();
}
