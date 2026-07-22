export function createBeforeQuitCoordinator({
  beginShutdown = () => () => {},
  runner,
  confirmActiveQuit,
  closeLauncher,
  quit
}) {
  let quitting = false;
  let ready = false;

  const beforeQuit = async (event) => {
    if (ready) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    let resumeWork = () => {};
    let cleanupStarted = false;
    try {
      resumeWork = beginShutdown();
      if (runner.hasActive() && !await confirmActiveQuit()) return;
      cleanupStarted = true;
      await runner.dispose();
      await closeLauncher();
      ready = true;
      quit();
    } finally {
      if (!ready) {
        if (!cleanupStarted) resumeWork();
        quitting = false;
      }
    }
  };

  const requestWindowClose = (event) => {
    if (ready) return;
    event.preventDefault();
    quit();
  };

  return {
    beforeQuit,
    requestWindowClose,
    readyToQuit: () => ready
  };
}
