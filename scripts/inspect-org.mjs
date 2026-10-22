/**
 * ============================================================================
 * 文件标识：scripts/inspect-org.mjs ｜ 组织与权限结构速查（只读）
 * ============================================================================
 * 【职责】组织与权限结构速查（只读）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 组织与权限结构速查（只读）
import Database from 'better-sqlite3'

const db = new Database('data/gml_cosmetic.db', { readonly: true })

console.log('===== 组织树（美妆版）=====')
for (const o of db.prepare("SELECT id,code,name,type,level,path,is_legal,owner_org_id FROM orgs WHERE type IN ('group','region','store','kitchen') ORDER BY path").all()) {
  const ind = '  '.repeat(o.level)
  const own = db.prepare('SELECT name FROM orgs WHERE id=?').get(o.owner_org_id)
  console.log(`${ind}${o.name} (${o.type} L${o.level})${o.is_legal ? ' [独立主体]' : ''} path=${o.path} 货主=${own?.name || '-'}`)
}

console.log('\n===== 加盟店货权判定（第三轮 B2：加盟店是独立主体）=====')
for (const s of db.prepare('SELECT id,code,name,type,org_id,owner_org_id FROM stores').all()) {
  const own = db.prepare('SELECT name,type FROM orgs WHERE id=?').get(s.owner_org_id)
  const expect = s.type === 'franchise' ? '独立主体' : '归总部'
  const actual = s.owner_org_id === s.org_id ? '独立主体' : '归总部'
  console.log(`  ${s.name} [${s.type}] → 货主=${own?.name}  期望=${expect} 实际=${actual} ${expect === actual ? '✓' : '✗'}`)
}

console.log('\n===== 权限模型 =====')
console.log('  权限点', db.prepare('SELECT COUNT(*) c FROM permissions').get().c, '个')
for (const r of db.prepare('SELECT r.code,r.name,r.data_scope,COUNT(rp.perm_code) c FROM roles r LEFT JOIN role_permissions rp ON rp.role_code=r.code GROUP BY r.code ORDER BY r.sort_order').all()) {
  console.log(`  ${r.code.padEnd(10)}${r.name.padEnd(12)}数据范围=${r.data_scope.padEnd(8)}权限 ${r.c} 个`)
}

console.log('\n===== 用户挂组织 =====')
for (const u of db.prepare('SELECT u.username,u.name,u.role,u.org_id,u.data_scope,o.name oname,o.type otype FROM users u LEFT JOIN orgs o ON o.id=u.org_id ORDER BY u.id').all()) {
  console.log(`  ${u.username.padEnd(9)}${u.name.padEnd(9)}${u.role.padEnd(10)}→ ${u.oname} (${u.otype}) scope=${u.data_scope || '-'}`)
}

console.log('\n===== 组织职能开关（抽样）=====')
for (const f of db.prepare("SELECT o.name, GROUP_CONCAT(f.func_code) fns FROM org_functions f JOIN orgs o ON o.id=f.org_id WHERE o.type IN ('group','kitchen','store') GROUP BY o.id LIMIT 5").all()) {
  console.log(`  ${f.name}: ${f.fns}`)
}
db.close()
