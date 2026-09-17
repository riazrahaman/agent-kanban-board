import { after, before, describe, it } from 'node:test';
import assert from 'node:assert';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

describe('Project Namespacing (§2.1)', () => {
  let baseUrl;
  let serverProcess;

  before(async () => {
    const serverScript = path.resolve(__dirname, '../server/server.js');
    serverProcess = spawn('node', [serverScript], {
      env: { ...process.env, KANBAN_DEFAULT_PROJECT: 'default' }
    });

    await new Promise((resolve) => setTimeout(resolve, 2000));
    baseUrl = 'http://localhost:3000/api';
  });

  after(async () => {
    serverProcess.kill();
  });

  it('isolates tasks between different projects', async () => {
    // 1. Create task in Project-A
    const resA = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Task A', project: 'project-a' })
    });
    const dataA = await resA.json();
    const idA = dataA.id;
    assert.strictEqual(resA.status, 201);

    // 2. Attempt to retrieve it from Project-B (expect 404)
    const getB = await fetch(`${baseUrl}/tasks/${idA}?project=project-b`);
    assert.strictEqual(getB.status, 404);

    // 3. Create task in Project-B
    const resB = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Task B', project: 'project-b' })
    });
    const dataB = await resB.json();
    const idB = dataB.id;
    assert.strictEqual(resB.status, 201);

    // 4. Retrieve it from Project-B (expect 200)
    const getAfterB = await fetch(`${baseUrl}/tasks/${idB}?project=project-b`);
    const dataAfterB = await getAfterB.json();
    assert.strictEqual(dataAfterB.title, 'Task B');
  });

  it('respects the default project fallback', async () => {
    // 1. Create task in default project (no project param)
    const resDef = await fetch(`${baseUrl}/tasks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: 'Default Task' })
    });
    const dataDef = await resDef.json();
    const idDef = dataDef.id;
    assert.strictEqual(resDef.status, 201);

    // 2. Retrieve it via project-less lookup
    const getDef = await fetch(`${baseUrl}/tasks/${idDef}`);
    const dataGetDef = await getDef.json();
    assert.strictEqual(dataGetDef.title, 'Default Task');
    assert.strictEqual(dataGetDef.project, 'default');
  });
});
