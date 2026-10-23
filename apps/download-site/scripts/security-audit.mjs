import { main } from '../../../scripts/offline-audit.mjs';

try {
  const production = await main(['--omit=dev', '--audit-level=moderate']);
  if (production) process.exitCode = production;
  else process.exitCode = await main(['--audit-level=moderate', '--informational']);
} catch (error) {
  console.error(error.message);
  process.exitCode = 2;
}
