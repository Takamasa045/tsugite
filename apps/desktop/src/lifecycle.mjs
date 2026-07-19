export function createBeforeQuitCoordinator({
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
    try {
      if (runner.hasActive() && !await confirmActiveQuit()) return;
      await runner.dispose();
      await closeLauncher();
      ready = true;
      quit();
    } finally {
      if (!ready) quitting = false;
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
