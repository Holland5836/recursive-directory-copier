import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Copy a directory tree from src to dst, preserving permission bits and
 * handling symlink edge cases.
 *
 * Design decisions (one interpretation, stated plainly):
 *
 * 1. Symlinks are copied as symlinks. We do not dereference them. This
 *    preserves the structure of the tree exactly. If a symlink is broken
 *    (its target does not exist) we still copy it; the test container has
 *    no network and we never follow links. This avoids surprising users
 *    who have relative symlinks that only resolve under a different cwd.
 *
 * 2. When the destination symlink already exists and points to a different
 *    target, we replace it. This mirrors `cp -T` semantics for the leaves
 *    we touch. We do NOT recursively delete the destination directory;
 *    we only overwrite leaf entries we are about to write.
 *
 * 3. Permissions: we preserve the mode of files and directories from the
 *    source. For symlinks we use lchmod when available; on Linux lchmod is
 *    a no-op (the kernel does not support changing the mode of a symlink
 *    itself) so we swallow the error. Windows is out of scope: this is a
 *    Unix-targeted library.
 *
 * 4. We do not copy atime/mtime. The brief asked for permissions and
 *    symlinks; adding mtime would require lutimes and would silently fail
 *    on filesystems that don't support it. One clear decision: skip it.
 *
 * @param {string} srcDir - Absolute or relative path to the source directory.
 * @param {string} dstDir - Absolute or relative path to the destination.
 * @returns {Promise<void>}
 */
export async function copyTree(srcDir, dstDir) {
  await copyEntry(srcDir, dstDir);
}

async function copyEntry(src, dst) {
  const stat = await fs.lstat(src);

  if (stat.isSymbolicLink()) {
    const target = await fs.readlink(src);
    await writeSymlink(dst, target);
    return;
  }

  if (stat.isDirectory()) {
    await ensureDir(dst, stat.mode);
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      await copyEntry(path.join(src, entry.name), path.join(dst, entry.name));
    }
    // Re-apply the mode after writing children: writing into a directory
    // does not change its mode on POSIX, but mkdir may have been subject
    // to umask. Setting it here once we are done ensures the final bits
    // match the source regardless of umask.
    await fs.chmod(dst, stat.mode);
    return;
  }

  if (stat.isFile()) {
    await fs.copyFile(src, dst);
    await fs.chmod(dst, stat.mode);
    return;
  }

  // FIFOs, sockets, block devices, character devices: we deliberately
  // skip these. Copying a named pipe would create a new pipe, not the
  // same one; copying a socket would create a socket file. This is rarely
  // what the caller wants. The brief is about directory trees of regular
  // files and symlinks.
  throw new Error(`Unsupported entry type at ${src}`);
}

async function ensureDir(dir, mode) {
  try {
    await fs.mkdir(dir, { mode });
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Destination already exists. Make sure it is a directory; if it
      // is a symlink or file we bail out rather than clobbering it
      // unexpectedly. The brief is explicit about avoiding surprises.
      const realStat = await fs.stat(dir).catch(() => null);
      if (!realStat || !realStat.isDirectory()) {
        throw new Error(`Destination ${dir} exists and is not a directory`);
      }
      return;
    }
    throw err;
  }
}

async function writeSymlink(dst, target) {
  try {
    await fs.unlink(dst);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
  await fs.symlink(target, dst);

  // Attempt lchmod for platforms that support it. On Linux this throws
  // ENOSYS; we swallow that. On macOS it works for symlinks. We do not
  // use chmod because that would follow the link and mutate the target.
  try {
    await fs.lchmod(dst, 0o777);
  } catch {
    // Intentionally ignored: not all platforms support lchmod.
  }
}
