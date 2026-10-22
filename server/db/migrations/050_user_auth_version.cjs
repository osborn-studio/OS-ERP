'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/050_user_auth_version.cjs ｜ 账号会话撤销版本，重跑不重置
 * ============================================================================
 */
const { addColumn, hasColumn } = require('./_helpers.cjs')
module.exports.name = '账号会话撤销版本'
module.exports.up = db => addColumn(db, 'users', 'auth_version', 'INTEGER NOT NULL DEFAULT 0 CHECK(auth_version >= 0)')
module.exports.verify = db => hasColumn(db, 'users', 'auth_version')
