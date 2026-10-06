// Recompute tiers offline from the local database: `npm run score`.
// No GMGN calls (the running service owns the API budget): PnL comes from
// the last values the service stored.
import { openDb } from '../dist/db.js';
import { Scorer } from '../dist/scorer/scorer.js';

const db = openDb(process.env.DATA_DIR || './data');
const result = await new Scorer(db).run();
console.log(JSON.stringify(result));
