// ========================================================
// Argon2id 密碼雜湊與加驗證工具模組 (utils/authUtils.ts)
// ========================================================
import { argon2id } from 'hash-wasm'

// Argon2id 安全參數配置
const ARGON2_PARAMS = {
  memorySize: 65536, // 64 MB
  iterations: 3,     // 3 次迭代
  parallelism: 1,    // 1 個並行執行緒
  hashLength: 32,    // 32-byte 雜湊長度
  outputFormat: 'hex' as const
}

/**
 * 使用 Argon2id 演算法加鹽雜湊密碼
 * @param password 明文密碼
 * @returns 格式化為 PHC 格式之 Argon2id 雜湊字串 ($argon2id$v=19$m=65536,t=3,p=1$<saltHex>$<hashHex>)
 */
export async function hashPassword(password: string): Promise<string> {
  // 生成 16 位元組 (128-bit) 隨機鹽值
  const saltArray = new Uint8Array(16)
  crypto.getRandomValues(saltArray)
  const saltHex = Array.from(saltArray).map(b => b.toString(16).padStart(2, '0')).join('')

  // 透過 Wasm-powered Argon2id 計算雜湊
  const hashHex = await argon2id({
    password,
    salt: saltArray,
    memorySize: ARGON2_PARAMS.memorySize,
    iterations: ARGON2_PARAMS.iterations,
    parallelism: ARGON2_PARAMS.parallelism,
    hashLength: ARGON2_PARAMS.hashLength,
    outputFormat: 'hex'
  })

  // 組合為標準 Argon2id PHC 格式字串
  return `$argon2id$v=19$m=${ARGON2_PARAMS.memorySize},t=${ARGON2_PARAMS.iterations},p=${ARGON2_PARAMS.parallelism}$${saltHex}$${hashHex}`
}

/**
 * 驗證明文密碼與 Argon2id 雜湊字串是否相符
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
    const computedHashHex = await argon2id({
      password,
      salt: saltArray,
      memorySize,
      iterations,
      parallelism,
      hashLength: expectedHashHex.length / 2,
      outputFormat: 'hex'
    })

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
