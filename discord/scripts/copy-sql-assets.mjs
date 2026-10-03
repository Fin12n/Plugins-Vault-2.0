// tsc only emits .ts output, so non-TS assets loaded at runtime (schema.sql)
// must be copied into dist alongside the compiled modules.
import { cp } from 'node:fs/promises';

await cp('src/db/schema.sql', 'dist/src/db/schema.sql');
console.log('copied src/db/schema.sql -> dist/src/db/schema.sql');
