// ========================================================
// Argon2id 密碼雜湊與驗證工具模組 (utils/authUtils.ts)
// 使用 @noble/hashes 純 JS/TS 密碼學函式庫 (無 WebAssembly / 100% 相容 Cloudflare Workers)
// ========================================================
import { argon2id } from '@noble/hashes/argon2.js'

// Argon2id 安全參數配置 (遵循 OWASP 建議)
const ARGON2_PARAMS = {
  memorySize: 65536, // 64 MB (65536 KiB)
  iterations: 3,     // 3 次計算迭代 (t=3)
  parallelism: 1,    // 1 個平行執行緒 (p=1)
  hashLength: 32,    // 32-byte 雜湊長度
}

/**
 * 1. 使用 Argon2id 演算法加鹽雜湊密碼
 * @param password 明文密碼
 * @returns 格式化為 PHC 格式之 Argon2id 雜湊字串 ($argon2id$v=19$m=65536,t=3,p=1$<saltHex>$<hashHex>)
 */
export async function hashPassword(password: string): Promise<string> {
  // 生成 16 位元組 (128-bit) 密碼學安全亂數鹽值
  const saltArray = new Uint8Array(16)
  crypto.getRandomValues(saltArray)
  const saltHex = Array.from(saltArray).map(b => b.toString(16).padStart(2, '0')).join('')

  // 透過 @noble/hashes 純 JS 計算 Argon2id 雜湊 (無 WebAssembly.compile 限制)
  const hashBytes = argon2id(password, saltArray, {
    t: ARGON2_PARAMS.iterations,
    m: ARGON2_PARAMS.memorySize,
    p: ARGON2_PARAMS.parallelism,
    dkLen: ARGON2_PARAMS.hashLength
  })

  const hashHex = Array.from(hashBytes).map(b => b.toString(16).padStart(2, '0')).join('')

  // 組合為標準 Argon2id PHC 格式字串
  return `$argon2id$v=19$m=${ARGON2_PARAMS.memorySize},t=${ARGON2_PARAMS.iterations},p=${ARGON2_PARAMS.parallelism}$${saltHex}$${hashHex}`
}

/**
 * 2. 驗證明文密碼與 Argon2id 雜湊字串是否一致
 * @param password 明文密碼
 * @param hashString 資料庫中儲存之 Argon2id PHC 雜湊字串
 * @returns 驗證成功回傳 true，失敗回傳 false
 */
export async function verifyPassword(password: string, hashString: string): Promise<boolean> {
  try {
    if (!hashString || !hashString.startsWith('$argon2id$')) {
      return false
    }

    const parts = hashString.split('$')
    // parts 結構：['', 'argon2id', 'v=19', 'm=65536,t=3,p=1', saltHex, hashHex]
    if (parts.length < 6 || parts[1] !== 'argon2id') {
      return false
    }

    // 解析推導參數
    const paramParts = parts[3].split(',')
    let memorySize = ARGON2_PARAMS.memorySize
    let iterations = ARGON2_PARAMS.iterations
    let parallelism = ARGON2_PARAMS.parallelism

    for (const p of paramParts) {
      const [k, v] = p.split('=')
      if (k === 'm') memorySize = parseInt(v, 10)
      if (k === 't') iterations = parseInt(v, 10)
      if (k === 'p') parallelism = parseInt(v, 10)
    }

    const saltHex = parts[4]
    const expectedHashHex = parts[5]

    // 將 hex salt 轉回 Uint8Array
    const saltBytes = saltHex.match(/.{1,2}/g)?.map(byte => parseInt(byte, 16)) || []
    const saltArray = new Uint8Array(saltBytes)

    // 重建計算當前密碼之 Argon2id 雜湊
    const computedHashBytes = argon2id(password, saltArray, {
      t: iterations,
      m: memorySize,
      p: parallelism,
      dkLen: expectedHashHex.length / 2
    })

    const computedHashHex = Array.from(computedHashBytes).map(b => b.toString(16).padStart(2, '0')).join('')

    // 比對雜湊值
    return computedHashHex === expectedHashHex
  } catch (error) {
    console.error('verifyPassword 驗證錯誤:', error)
    return false
  }
}

/**
 * 解析 HTTP Cookie 標頭
 */
export function parseCookies(cookieHeader: string | null): Record<string, string> {
  const list: Record<string, string> = {}
  if (!cookieHeader) return list

  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.split('=')
    if (parts.length >= 2) {
      const name = parts[0].trim()
      const val = parts.slice(1).join('=').trim()
      list[name] = decodeURIComponent(val)
    }
  })

  return list
}
