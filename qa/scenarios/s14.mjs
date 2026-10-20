// S14 - re-plan in the same session with the todo-17 adapter applied to a
// temp PLUGIN copy.
import { parseArgs } from 'node:util';
import { runReplan } from './s14-common.mjs';

export async function run({ out }) {
  return runReplan({ out, name: 'S14', adapter: true });
}

const invokedDirectly = process.argv[1]?.endsWith('s14.mjs');
if (invokedDirectly) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } });
  if (!values.out) {
    console.error('usage: node qa/scenarios/s14.mjs --out <evidence dir>');
    process.exitCode = 2;
  } else {
    run({ out: values.out }).catch((error) => {
      console.error(error?.stack ?? error);
      process.exitCode = 1;
    });
  }
}
