/**
 * [graft-Max] 用户全局文件的安全落盘：同目录 tmp + rename 原子替换 + 可选 .bak 轮转
 * + 可选写前 JSON 校验。
 *
 * 为什么必须 tmp+rename（Why tmp+rename, not a direct overwrite）：
 * 直接 `writeFileSync(path, content)` 是「先截断再写」——truncate 与 write 之间有窗口。
 * 进程在那一刻被杀、磁盘满、断电，或另一个进程（Claude Code 主进程本身就在写
 * `~/.claude.json`）同时写同一文件，用户文件就只剩半截或 0 字节。本项目真实发生过：
 * `~/.claude.json` 246KB 被整写成 852B，用户全部 MCP 配置丢失（见
 * `docs-selfdev/项目约束.md` §8）。同目录 rename 是 POSIX/NTFS 上的原子操作：
 * 目录项一次性换成新 inode，读者要么看到旧全文、要么看到新全文，不存在中间态。
 * 临时文件必须与目标**同目录**——跨卷/跨文件系统的 rename 会退化成 copy+delete，
 * 原子性消失（EXDEV）。
 *
 * 三层保护：
 *   1. tmp + rename —— 主写入永不产生半截文件（任何失败都删 tmp 并 rethrow，原文件不变）
 *   2. .bak 轮转 —— 写坏了还能回到上一版（默认开，最多 3 份：.bak / .bak.1 / .bak.2）
 *   3. validateJson —— JSON 配置写前 parse 一遍，坏 JSON 根本不落盘
 *
 * 零第三方依赖：只用 node:fs / node:path / node:crypto。
 */
import {
  closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface AtomicWriteOptions {
  /** 写前保留上一版备份，默认 true。轮转最多保留 3 份：path.bak / path.bak.1 / path.bak.2 */
  backup?: boolean;
  /** 写入前用 JSON.parse 校验内容（写 JSON 文件时传 true），失败直接 throw，原文件不动 */
  validateJson?: boolean;
  /** 写文件与读备份用的编码，默认 'utf8' */
  encoding?: BufferEncoding;
}

/** 备份保留份数：.bak, .bak.1, .bak.2（.bak 是最新的一版旧内容）。 */
const BACKUP_GENERATIONS = 3;

/**
 * 把 `data` 原子地写成 `path`：同目录 tmp → fsync（尽力而为）→ rename。
 * 任何一步失败都删掉 tmp 并 rethrow；`path` 保持原样（或原本不存在）。
 */
export function atomicWriteSync(path: string, data: string, opts: AtomicWriteOptions = {}): void {
  const { backup = true, validateJson = false, encoding = 'utf8' } = opts;
  if (validateJson) assertValidJson(path, data);
  // 备份内容必须在 rename 之前读出来——rename 之后旧内容就没了。
  const prev = backup ? readPrev(path, encoding) : undefined;
  replaceViaTmp(path, data, encoding);
  if (prev !== undefined) rotateBackup(path, prev, encoding);
}

/** `atomicWriteSync` 的异步版：同样的 tmp + rename，只换 fs/promises。 */
export async function atomicWrite(path: string, data: string, opts: AtomicWriteOptions = {}): Promise<void> {
  const { backup = true, validateJson = false, encoding = 'utf8' } = opts;
  if (validateJson) assertValidJson(path, data);
  const fs = await import('node:fs/promises');
  const prev = backup ? await readPrevAsync(fs, path, encoding) : undefined;

  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try {
    await fs.writeFile(tmp, data, encoding);
    await fsyncBestEffortAsync(tmp);
    let attempt = 0;
    for (;;) {
      try {
        await fs.rename(tmp, path);
        break;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if ((code !== 'EPERM' && code !== 'EACCES') || ++attempt > RENAME_RETRY_MAX) throw err;
        await new Promise((r) => setTimeout(r, RENAME_RETRY_MS));
      }
    }
  } catch (err) {
    try { await fs.rm(tmp, { force: true }); } catch { /* tmp 已经不在：忽略 */ }
    throw err;
  }
  if (prev !== undefined) await rotateBackupAsync(fs, path, prev, encoding);
}

/* -------------------------------------------------------------------------- */
/* 内部实现                                                                    */
/* -------------------------------------------------------------------------- */

/** 写前 JSON 校验：坏内容一个字节都不落盘（比「写完发现坏了再回滚」安全）。 */
function assertValidJson(path: string, data: string): void {
  try {
    JSON.parse(data);
  } catch {
    throw new Error('refusing to write invalid JSON to ' + path);
  }
}

/** `<path>.<pid>.<rand>.tmp` —— 同目录、同文件系统，保证 rename 是原子替换。 */
function tmpName(path: string): string {
  return `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
}

/** 读旧内容；文件不存在（首次创建）返回 undefined，读失败同样当作没有上一版。 */
function readPrev(path: string, encoding: BufferEncoding): string | undefined {
  try { return readFileSync(path, encoding); } catch { return undefined; }
}

async function readPrevAsync(
  fs: typeof import('node:fs/promises'), path: string, encoding: BufferEncoding,
): Promise<string | undefined> {
  try { return await fs.readFile(path, encoding) as string; } catch { return undefined; }
}

/**
 * 核心：同目录写 tmp → fsync（尽力而为，某些文件系统/杀毒软件会拒绝）→ rename。
 * rename 失败 = 原文件完好无损，只留下一个 tmp 需要清理。
 *
 * [M13] Windows 的 rename 在目标正被另一个 rename 占用的瞬间会抛 EPERM/EACCES
 * （几毫秒的窗口，多进程写 sessions.json 时真实发生，实测并发 8 路必现一次）。
 * 这类错误**短退避重试**是安全的：tmp 是唯一的，重试不可能覆盖别人的写入；
 * 其余错误（文件被锁死、权限缺失）重试也不会好，立即 rethrow。
 * 总预算 ~80ms，远小于任何一次真实的写放大。
 */
const RENAME_RETRY_MS = 10;
const RENAME_RETRY_MAX = 8;

function replaceViaTmp(path: string, data: string, encoding: BufferEncoding): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = tmpName(path);
  try {
    writeFileSync(tmp, data, encoding);
    fsyncBestEffort(tmp);
    let attempt = 0;
    for (;;) {
      try {
        renameSync(tmp, path);
        return;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        const retryable = code === 'EPERM' || code === 'EACCES';
        if (!retryable || ++attempt > RENAME_RETRY_MAX) throw err;
        const spinUntil = Date.now() + RENAME_RETRY_MS;
        while (Date.now() < spinUntil) { /* 忙等几毫秒：比 setTimeout 精确，且窗口本来就小 */ }
      }
    }
  } catch (err) {
    // 半截 tmp 绝不能留下：既污染目录，也可能被下一次调试误读成"写成功"。
    try { rmSync(tmp, { force: true }); } catch { /* tmp 已经不在：忽略 */ }
    throw err;
  }
}

/** fsync 尽力而为：把 tmp 的内容真正刷到磁盘，断电也不丢。失败不影响写入结果。 */
function fsyncBestEffort(path: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r+');
    fsyncSync(fd);
  } catch { /* 平台/文件系统不支持：跳过，rename 本身仍是原子的 */ }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* ignore */ } }
}

async function fsyncBestEffortAsync(path: string): Promise<void> {
  const fs = await import('node:fs/promises');
  let fh: import('node:fs/promises').FileHandle | undefined;
  try {
    fh = await fs.open(path, 'r+');
    await fh.sync();
  } catch { /* 同上 */ }
  finally { if (fh) try { await fh.close(); } catch { /* ignore */ } }
}

/**
 * 备份轮转：`.bak.1` → `.bak.2`（旧的 `.bak.2` 直接丢），`.bak` → `.bak.1`，
 * 然后把上一版内容写成新的 `.bak`。备份链只保留 {@link BACKUP_GENERATIONS} 份。
 * 备份失败一律吞掉：主写入已经成功，备份是加分项，不能反过来让调用方看到失败。
 */
function rotateBackup(path: string, prev: string, encoding: BufferEncoding): void {
  try {
    // 最老的一代（.bak.2）直接丢弃，绝不产生 .bak.3。
    try { rmSync(`${path}.bak.${BACKUP_GENERATIONS - 1}`, { force: true }); } catch { /* 不存在：忽略 */ }
    for (let i = BACKUP_GENERATIONS - 2; i >= 1; i--) {
      try { renameSync(`${path}.bak.${i}`, `${path}.bak.${i + 1}`); } catch { /* 该代不存在：跳过 */ }
    }
    try { renameSync(`${path}.bak`, `${path}.bak.1`); } catch { /* 首次写：没有 .bak */ }
  } catch { /* 轮转整体失败：不影响主写入 */ }
  try {
    replaceViaTmp(`${path}.bak`, prev, encoding);
  } catch { /* 备份写失败：吞掉 */ }
}

async function rotateBackupAsync(
  fs: typeof import('node:fs/promises'), path: string, prev: string, encoding: BufferEncoding,
): Promise<void> {
  try {
    try { await fs.rm(`${path}.bak.${BACKUP_GENERATIONS - 1}`, { force: true }); } catch { /* 不存在 */ }
    for (let i = BACKUP_GENERATIONS - 2; i >= 1; i--) {
      try { await fs.rename(`${path}.bak.${i}`, `${path}.bak.${i + 1}`); } catch { /* 该代不存在 */ }
    }
    try { await fs.rename(`${path}.bak`, `${path}.bak.1`); } catch { /* 首次写 */ }
  } catch { /* ignore */ }
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = tmpName(`${path}.bak`);
    try {
      await fs.writeFile(tmp, prev, encoding);
      await fs.rename(tmp, `${path}.bak`);
    } catch (err) {
      try { await fs.rm(tmp, { force: true }); } catch { /* ignore */ }
      throw err;
    }
  } catch { /* 备份写失败：吞掉 */ }
}
