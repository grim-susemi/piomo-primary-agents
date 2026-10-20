// S15 - adapter missing (unpatched temp PLUGIN copy): after execution the
// re-plan is refused, the Korean notice is shown, nothing crashes.
import { parseArgs } from 'node:util';
import { runReplan } from './s14-common.mjs';

export async function run({ out }) {
  return runReplan({ out, name: 'S15', adapter: false });
}

const invokedDirectly = process.argv[1]?.endsWith('s15.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s15.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
