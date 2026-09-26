const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

async function fixture(state = 'running') {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gascost-backup-test-'));
  for (const name of ['project', 'backups', 'data', 'bin', 'restore']) await fs.mkdir(path.join(root, name));
  await fs.writeFile(path.join(root, 'project', 'compose.yaml'), 'services: {}\n');
  await fs.writeFile(path.join(root, 'project', '.env'), 'BOOTSTRAP_TOKEN=test-only\n');
  await fs.copyFile(path.join(__dirname, 'fixtures/docker-backup-mock.sh'), path.join(root, 'bin/docker'));
  await fs.chmod(path.join(root, 'bin/docker'), 0o700);
  const databases = ['auth.db', 'gascost.db'].map((name) => {
    const db = new DatabaseSync(path.join(root, 'data', name));
    db.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE sample (value TEXT); INSERT INTO sample VALUES ('preservado');");
    return db;
  });
  const env = { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, PROJECT_DIR: `${root}/project`, BACKUP_DIR: `${root}/backups`,
    TEST_DOCKER_LOG: `${root}/calls`, TEST_DATA: `${root}/data`, TEST_CONTAINER_STATE: state, RETENTION_DAYS: '30' };
  return { root, databases, env, run: (extra = {}) => spawnSync('bash', [path.join(__dirname, '../deploy/backup.sh')], { env: { ...env, ...extra }, encoding: 'utf8' }) };
}

test('backup preserva WAL, configuração e checksum; restaura bancos íntegros e aplica retenção', async () => {
  const f = await fixture();
  try {
    for (const file of ['gascost-old.tar.gz', 'gascost-old.tar.gz.sha256', 'outro-arquivo.txt']) {
      const target = path.join(f.root, 'backups', file);
      await fs.writeFile(target, 'old'); await fs.utimes(target, new Date(0), new Date(0));
    }
    const result = f.run(); assert.equal(result.status, 0, result.stderr);
    const files = await fs.readdir(`${f.root}/backups`);
    assert.ok(!files.includes('gascost-old.tar.gz'));
    assert.ok(files.includes('outro-arquivo.txt'));
    const archive = files.find((name) => name.endsWith('.tar.gz'));
    assert.ok(archive);
    assert.equal((await fs.stat(`${f.root}/backups/${archive}`)).mode & 0o777, 0o600);
    assert.equal(spawnSync('sha256sum', ['-c', `${archive}.sha256`], { cwd: `${f.root}/backups` }).status, 0);
    assert.equal(spawnSync('tar', ['-xzf', `${f.root}/backups/${archive}`, '-C', `${f.root}/restore`]).status, 0);
    for (const file of ['auth.db', 'gascost.db']) {
      const db = new DatabaseSync(`${f.root}/restore/data/${file}`);
      assert.equal(db.prepare('SELECT value FROM sample').get().value, 'preservado');
      assert.equal(db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
      db.close();
    }
    const config = spawnSync('tar', ['-xzOf', `${f.root}/restore/application.tar.gz`, './.env'], { encoding: 'utf8' });
    assert.match(config.stdout, /BOOTSTRAP_TOKEN=test-only/);
    const calls = await fs.readFile(`${f.root}/calls`, 'utf8'); assert.match(calls, /stop\ncp\nstart/);
    assert.ok(!files.some((name) => name.startsWith('.pending.')));
  } finally { f.databases.forEach((db) => db.close()); await fs.rm(f.root, { recursive: true }); }
});

test('falha na cópia reinicia aplicação e não elimina backups anteriores', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(`${f.root}/backups/gascost-old.tar.gz`, 'old');
    await fs.utimes(`${f.root}/backups/gascost-old.tar.gz`, new Date(0), new Date(0));
    assert.notEqual(f.run({ TEST_COPY_FAIL: '1' }).status, 0);
    assert.match(await fs.readFile(`${f.root}/calls`, 'utf8'), /stop\ncp\nstart/);
    assert.equal(await fs.readFile(`${f.root}/backups/gascost-old.tar.gz`, 'utf8'), 'old');
    assert.ok(!(await fs.readdir(`${f.root}/backups`)).some((name) => name.startsWith('.pending.')));
  } finally { f.databases.forEach((db) => db.close()); await fs.rm(f.root, { recursive: true }); }
});

test('backup de container parado não inicia o serviço', async () => {
  const f = await fixture('exited');
  try {
    assert.equal(f.run().status, 0);
    assert.doesNotMatch(await fs.readFile(`${f.root}/calls`, 'utf8'), /start|stop/);
  } finally { f.databases.forEach((db) => db.close()); await fs.rm(f.root, { recursive: true }); }
});
