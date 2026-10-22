/**
 * ============================================================================
 * 文件标识：scripts/db-inventory.mjs ｜ db-inventory（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】db-inventory（按文件名推断，待人工完善）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自文件名推断**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

import Database from 'better-sqlite3';
import fs from 'fs';
const files = fs.readdirSync('data').filter(f=>f.endsWith('.db'));
for (const f of files){
  const db = new Database('data/'+f, {readonly:true});
  const t = db.prepare("select name,type from sqlite_master where type in ('table','view') and name not like 'sqlite_%' order by type,name").all();
  const tab = t.filter(x=>x.type==='table').map(x=>x.name);
  const views = t.filter(x=>x.type==='view').map(x=>x.name);
  let mig = [];
  try { mig = db.prepare('select version from schema_migrations order by version').all().map(r=>r.version); } catch(e){}
  console.log(`\n### ${f}  表${tab.length} 视图${views.length} 迁移${mig.length} (${mig[mig.length-1]||'-'})`);
  console.log(tab.join(','));
  if(views.length) console.log('VIEWS:', views.join(','));
  const pragma = db.pragma('journal_mode'), bt = db.pragma('busy_timeout');
  console.log('journal:', JSON.stringify(pragma), 'busy_timeout:', JSON.stringify(bt));
  db.close();
}
