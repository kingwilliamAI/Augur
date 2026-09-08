import { openDb } from "../db.ts";
import { backfillQuoteAssets } from "../quote.ts";

const db = openDb();
console.log(`resolved ${await backfillQuoteAssets(db)} new quote assets`);
console.table(db.prepare(`
  SELECT q.symbol, q.decimals, count(*) launches FROM quote_assets q
  JOIN launches l ON l.pair_token = q.address GROUP BY q.address ORDER BY launches DESC LIMIT 12`).all());
db.close();
