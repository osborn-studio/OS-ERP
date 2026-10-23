/**
 * ============================================================================
 * 文件标识：server/lib/backup-dir.js ｜ 备份输出目录的唯一解析点：相对路径落在 GML_DATA_DIR 内，不落仓库
 * ============================================================================
 * 【职责】把 settings.backup_dir（或缺省值）解析成绝对目录。
 *
 * 【为什么这样设计】ADR-0001 禁止隐式使用仓库 data/；旧版脚本把相对目录拼到项目根，
 *   会把生产备份写进代码仓库。这里统一按数据目录解析：
 *     · 绝对路径 → 原样；
 *     · 相对路径 → `GML_DATA_DIR/<相对路径>`；
 *     · 迁移 020 写进每个库的旧缺省值 `data/backups` 等价于新缺省值 `backups`
 *       （`GML_DATA_DIR/backups`），否则会得到 `GML_DATA_DIR/data/backups` 这种误导性路径。
 *
 * 【改它要注意什么】db-backup / db-reset 都只经过这里；别在脚本里再拼第二份规则。
 * ============================================================================
 */
import path from 'node:path'

export const DEFAULT_BACKUP_DIR = 'backups'
/** 迁移 020 与旧版 settings 缺省写入的值；按新缺省值解释。 */
export const LEGACY_DEFAULT_BACKUP_DIR = 'data/backups'

export function resolveBackupDir(value, dataDir) {
  if (!dataDir || !path.isAbsolute(dataDir)) {
    throw Object.assign(new Error('Backup directory resolution requires an absolute data directory'), { code: 'DATA_DIRECTORY_REQUIRED' })
  }
  let dir = typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_BACKUP_DIR
  if (dir === LEGACY_DEFAULT_BACKUP_DIR) dir = DEFAULT_BACKUP_DIR
  return path.isAbsolute(dir) ? path.normalize(dir) : path.join(dataDir, dir)
}
