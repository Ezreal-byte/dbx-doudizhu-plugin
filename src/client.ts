import type { DbxBridge, Profile } from './types'

export class ClientError extends Error {
  code: string
  constructor(message: string, code = 'REQUEST_FAILED') {
    super(message)
    this.name = 'ClientError'
    this.code = code
  }
}

export const previewProfile: Profile = {
  id: 'preview', nickname: '田园牌友', character: 0,
  music: 0.35, sound: 0.7, voice: 0.65, lowMotion: false,
}

export function bridge(): DbxBridge | undefined { return window.dbxPlugin }
export function isConnectedHost(): boolean { return Boolean(bridge()) }

export function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object' && 'message' in error) return String(error.message)
  return '操作没有完成，请稍后重试。'
}

export async function invoke<T>(method: string, params: unknown = {}): Promise<T> {
  const host = bridge()
  if (!host) throw new ClientError('当前是界面预览。请在 DBX 中打开插件后使用局域网联机。', 'PREVIEW_MODE')
  try {
    await host.ready
    return await host.invoke<T>(method, params, { timeoutMs: method === 'lobby.scan' ? 12000 : 15000 })
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'REQUEST_FAILED'
    throw new ClientError(errorText(error), code)
  }
}

export function subscribe(callback: (method: string, params: unknown) => void): () => void {
  const host = bridge()
  if (!host) return () => undefined
  return host.onEvent((payload) => {
    const event = payload as unknown as { method?: string; params?: unknown; event?: { method?: string; params?: unknown } }
    const normalized = event.event ?? event
    if (normalized.method) callback(normalized.method, normalized.params)
  })
}

export async function readAssetUrl(path: string): Promise<string> {
  const normalized = path.replace(/^\//, '')
  const host = bridge()
  if (!host) return `./${normalized}`
  await host.ready
  return host.readAssetUrl(normalized)
}

export function actionId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `action-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export async function copyText(value: string): Promise<void> {
  const host = bridge()
  if (host?.copy) return host.copy(value)
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value)
  throw new ClientError('无法自动复制，请手动选择并复制房间地址。', 'CLIPBOARD_UNAVAILABLE')
}
