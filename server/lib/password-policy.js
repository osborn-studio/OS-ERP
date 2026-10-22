/**
 * ============================================================================
 * 文件标识：server/lib/password-policy.js ｜ 新设密码的共享纯校验；登录旧密码不套用新强度规则
 * ============================================================================
 */
export function validateNewPassword(password) {
  if (typeof password !== 'string' || [...password].length < 16 || Buffer.byteLength(password, 'utf8') > 72 ||
      /[\u0000-\u001f\u007f]/u.test(password) || new Set(password).size < 6) {
    throw Object.assign(new Error('新密码至少16个字符、最多72个UTF-8字节，至少包含6种不同字符，且不含控制字符'), { code: 'PASSWORD_POLICY_INVALID', status: 400 })
  }
  return password
}
