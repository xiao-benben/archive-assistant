import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import ts from 'typescript';

// Execute the actual effect bodies with a delayed native registration, as happens
// during rapid navigation / React StrictMode. No user files or live database.
const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const ast = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const effects = [];
function visit(node) {
  if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect') {
    const body = node.arguments[0].getText(ast);
    if (body.includes('onDragDropEvent')) effects.push(body);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
test('both native drop entry points are covered', () => assert.equal(effects.length, 2));
test('theme previews immediately and restores saved appearance when leaving settings', () => {
  const settings = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'SettingsPage');
  let effect;
  function find(node) {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === 'useEffect'
      && node.arguments[0].getText(ast).includes('dataset.theme')) effect = node.arguments[0].getText(ast);
    ts.forEachChild(node, find);
  }
  find(settings);
  assert.ok(effect, 'settings must apply the selected theme');
  const document = { documentElement: { dataset: { theme: 'light' } } };
  const run = new Function('document', 'draft', 'value', `return (${effect})();`);
  const cleanup = run(document, { theme: 'dark' }, { theme: 'light' });
  assert.equal(document.documentElement.dataset.theme, 'dark');
  cleanup();
  assert.equal(document.documentElement.dataset.theme, 'light');
  run(document, { theme: 'dark' }, { theme: 'dark' })();
  assert.equal(document.documentElement.dataset.theme, 'dark');
});
for (const [index, body] of effects.entries()) {
 for (const earlyCleanup of [true, false]) {
  test(`drop listener ${index + 1}: ${earlyCleanup ? 'late registration is inert' : 'active registration works and cleans up'}`, async () => {
    let handler, finish;
    let stopped = 0, writes = 0;
    const noop = () => {};
    const env = {
      isTauri: () => true, view: 'workspace', path: '技术工作', category: 'notice',
      getCurrentWindow: () => ({ onDragDropEvent: (callback) => {
        handler = callback;
        return new Promise(resolve => { finish = () => resolve(() => stopped++); });
      }}),
      setDragging: noop, setDropping: noop, setBusy: noop,
      api: { importFiles: async () => { writes++; return { message: 'ok' }; } },
      drop: () => writes++, load: noop, refresh: noop, tell: noop, message: String,
    };
    const js = ts.transpile(`const effect = ${body}`, { target: ts.ScriptTarget.ES2022 });
    const cleanup = new Function(...Object.keys(env), `${js}; return effect();`)(...Object.values(env));
    if (earlyCleanup) cleanup();
    handler({ payload: { type: 'drop', paths: ['fixture.docx'] } });
    finish();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(writes, earlyCleanup ? 0 : 1, 'only the active target may write');
    if (!earlyCleanup) cleanup();
    handler({ payload: { type: 'drop', paths: ['another.docx'] } });
    assert.equal(writes, earlyCleanup ? 0 : 1, 'disposed callbacks cannot write');
    assert.equal(stopped, 1, 'late registration must be unregistered');
  });
 }
}
test('weekly panel includes daily and weekly tasks within the selected week', () => {
  const expression = source.match(/const weeklyTasks = ([\s\S]*?);/)[1];
  const tasks = [
    { id: 'daily', planScope: 'daily', dueDate: '2026-09-05' },
    { id: 'weekly', planScope: 'weekly', dueDate: '2026-09-06' },
    { id: 'next', planScope: 'daily', dueDate: '2026-09-07' },
  ];
  const result = new Function('tasks', 'weekStart', 'weekEnd', `return ${expression}`)(tasks, '2026-08-31', '2026-09-06');
  assert.deepEqual(result.map(t => t.id), ['daily', 'weekly']);
});
test('reminders include overdue and all-day tasks, exclude future and completed tasks', () => {
  const rust = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  const sql = rust.slice(rust.indexOf('fn remind_due_tasks')).match(/"(SELECT id,title,[\s\S]*?FROM tasks\s+WHERE completed=0[\s\S]*?)"/)[1];
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('CREATE TABLE tasks(id TEXT,title TEXT,due_date TEXT,remind_at TEXT,completed INTEGER)');
    const insert = db.prepare('INSERT INTO tasks VALUES(?,?,?,?,?)');
    for (const row of [
      ['overdue', 'Yesterday', '2026-09-04', '18:00', 0],
      ['all-day', 'Today', '2026-09-05', null, 0],
      ['timed', 'Now', '2026-09-05', '09:00', 0],
      ['later', 'Later', '2026-09-05', '10:00', 0],
      ['future', 'Tomorrow', '2026-09-06', null, 0],
      ['done', 'Done', '2026-09-04', '09:00', 1],
    ]) insert.run(...row);
    assert.deepEqual(db.prepare(sql).all({ 1: '2026-09-05', 2: '09:00' }).map(r => r.id).sort(), ['all-day', 'overdue', 'timed']);
  } finally { db.close(); }
});
