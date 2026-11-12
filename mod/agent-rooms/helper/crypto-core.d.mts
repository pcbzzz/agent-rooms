export type Device = { id: string; signPub: string; encPub: string; signPriv: string; encPriv: string }
export type PublicDevice = { id: string; encPub: string }
export type Envelope = { v: 1; from: string; eph: string; iv: string; ct: string; keys: { to: string; iv: string; wk: string }[]; sig: string }
export type Bytes = Uint8Array<ArrayBuffer>
export type SealedFile = { ct: Bytes; key: string; iv: string }

export function b64(bytes: ArrayBuffer | Uint8Array): string
export function unb64(text: string): Bytes
export function generateDevice(): Promise<Device>
export function deviceFromSeeds(signSeed: Uint8Array, boxSeed: Uint8Array): Promise<Device>
export function deviceId(signPub: string, encPub: string): Promise<string>
export function formatFingerprint(id: string): string
export function seal(args: { channelId: string; sender: Device; recipients: PublicDevice[]; payload: unknown }): Promise<Envelope>
export function open<T = unknown>(args: { channelId: string; envelope: Envelope; me: Device; senderSignPub: string }): Promise<T>
export function encryptFile(bytes: Uint8Array): Promise<SealedFile>
export function decryptFile(ct: Uint8Array, file: { key: string; iv: string }): Promise<Bytes>
export const FILE_CHUNK: number
export type FileKey = { key: string; iv: string }
export function newFileKey(): Promise<FileKey>
export function encryptChunk(file: FileKey, index: number, last: boolean, bytes: Uint8Array): Promise<Bytes>
export function decryptChunk(file: FileKey, index: number, last: boolean, ct: Uint8Array): Promise<Bytes>
export function chunkCount(size: number): number
export function sealedChunkLength(size: number, index: number): number
export function storedRange(size: number, index: number, sealed: boolean): { offset: number; length: number }
export function inParallel(count: number, fn: (index: number) => Promise<void>, options?: { start?: number; max?: number; retries?: number }): Promise<void>
export function encryptState(state: unknown, secret: Uint8Array): Promise<string>
export function decryptState<T = unknown>(blob: string, secret: Uint8Array): Promise<T>
