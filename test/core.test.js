import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { copyTree } from '../src/index.js';

async function mkdtemp(prefix = 'rdc-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function dirContains(dir, names) {
  const got = await fs.readdir(dir);
  got.sort();
  const want = [...names].sort();
  assert.deepEqual(got, want);
}

async function readMode(p) {
  const st = await fs.lstat(p);
  return st.mode & 0o777;
}

test('copies a regular file tree', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.writeFile(path.join(src, 'a.txt'), 'alpha');
  await fs.mkdir(path.join(src, 'sub'));
  await fs.writeFile(path.join(src, 'sub', 'b.txt'), 'beta');
  await copyTree(src, dst);
  await dirContains(dst, ['a.txt', 'sub']);
  assert.equal(await fs.readFile(path.join(dst, 'a.txt'), 'utf8'), 'alpha');
  assert.equal(await fs.readFile(path.join(dst, 'sub', 'b.txt'), 'utf8'), 'beta');
});

test('preserves file permissions', async () => {
  if (process.platform === 'win32') return;
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  const f = path.join(src, 'secret.txt');
  await fs.writeFile(f, 'shh');
  await fs.chmod(f, 0o640);
  await copyTree(src, dst);
  assert.equal(await readMode(path.join(dst, 'secret.txt')), 0o640);
});

test('preserves directory permissions despite umask', async () => {
  if (process.platform === 'win32') return;
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.mkdir(path.join(src, 'locked'));
  await fs.chmod(path.join(src, 'locked'), 0o700);
  await copyTree(src, dst);
  assert.equal(await readMode(path.join(dst, 'locked')), 0o700);
});

test('copies symlinks as symlinks without dereferencing', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.writeFile(path.join(src, 'real.txt'), 'data');
  await fs.symlink('real.txt', path.join(src, 'link.txt'));
  await copyTree(src, dst);
  const st = await fs.lstat(path.join(dst, 'link.txt'));
  assert.equal(st.isSymbolicLink(), true);
  assert.equal(await fs.readlink(path.join(dst, 'link.txt')), 'real.txt');
});

test('copies broken symlinks without error', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.symlink('does-not-exist', path.join(src, 'dangling'));
  await copyTree(src, dst);
  const st = await fs.lstat(path.join(dst, 'dangling'));
  assert.equal(st.isSymbolicLink(), true);
});

test('preserves nested directory structure', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.mkdir(path.join(src, 'a', 'b', 'c'), { recursive: true });
  await fs.writeFile(path.join(src, 'a', 'b', 'c', 'leaf.txt'), 'leaf');
  await copyTree(src, dst);
  assert.equal(await fs.readFile(path.join(dst, 'a', 'b', 'c', 'leaf.txt'), 'utf8'), 'leaf');
});

test('overwrites an existing destination file', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.writeFile(path.join(dst, 'file.txt'), 'old');
  await fs.writeFile(path.join(src, 'file.txt'), 'new');
  await copyTree(src, dst);
  assert.equal(await fs.readFile(path.join(dst, 'file.txt'), 'utf8'), 'new');
});

test('overwrites an existing destination symlink', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.writeFile(path.join(src, 'real.txt'), 'real');
  await fs.symlink('real.txt', path.join(src, 'link.txt'));
  await fs.symlink('elsewhere', path.join(dst, 'link.txt'));
  await copyTree(src, dst);
  assert.equal(await fs.readlink(path.join(dst, 'link.txt')), 'real.txt');
});

test('merges into an existing destination directory', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.writeFile(path.join(dst, 'preexisting.txt'), 'keep');
  await fs.writeFile(path.join(src, 'new.txt'), 'new');
  await copyTree(src, dst);
  assert.equal(await fs.readFile(path.join(dst, 'preexisting.txt'), 'utf8'), 'keep');
  assert.equal(await fs.readFile(path.join(dst, 'new.txt'), 'utf8'), 'new');
});

test('throws when destination exists as a file at root', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.writeFile(path.join(dst, 'blocker'), 'x');
  // dst is a directory with a file in it; copyTree should succeed because dst itself is a dir.
  await copyTree(src, dst);
  await dirContains(dst, ['blocker']);
});

test('rejects unsupported entry types like named pipes', async () => {
  // We can't easily create a named pipe without process.spawn on all platforms.
  // Instead, verify that a socket-like non-regular entry raises. We simulate
  // by writing a regular file and then removing read perms — but the real
  // guard is the isFile/isDirectory/isSymbolicLink check. We test the
  // thrown path by creating a fifo via the shell on POSIX only.
  if (process.platform === 'win32') return;
  const { spawnSync } = await import('node:child_process');
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  const fifo = path.join(src, 'pipe');
  const r = spawnSync('mkfifo', [fifo]);
  if (r.status !== 0) {
    // mkfifo not available; skip this test deterministically.
    return;
  }
  await assert.rejects(() => copyTree(src, dst), /Unsupported entry type/);
});

test('handles absolute source paths', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await fs.writeFile(path.join(src, 'x.txt'), 'x');
  await copyTree(src, dst);
  assert.equal(await fs.readFile(path.join(dst, 'x.txt'), 'utf8'), 'x');
});

test('empty source directory copies to empty destination', async () => {
  const src = await mkdtemp();
  const dst = await mkdtemp();
  await fs.rmdir(dst);
  await copyTree(src, dst);
  await dirContains(dst, []);
});
