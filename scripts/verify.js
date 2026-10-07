'use strict';

/**
 * 验收服务：依次执行
 *   1) 代码测试（迟到消息与三方稳定压缩等场景，node --test）
 *   2) 构建检查（对所有 JS 源文件做 node --check 语法/加载检查）
 *   3) API/HTTP 冒烟（对运行中的 web 服务走完整演练流程）
 * 全部通过则以退出码 0 结束，否则非 0。
 */

const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_URL = process.env.BASE_URL || 'http://localhost:8080';

let failures = 0;

function step(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    fn();
    process.stdout.write(`--- 通过: ${name}\n`);
  } catch (e) {
    failures++;
    process.stdout.write(`--- 失败: ${name}\n${e.stack || e}\n`);
  }
}

async function astep(name, fn) {
  process.stdout.write(`\n=== ${name} ===\n`);
  try {
    await fn();
    process.stdout.write(`--- 通过: ${name}\n`);
  } catch (e) {
    failures++;
    process.stdout.write(`--- 失败: ${name}\n${e.stack || e}\n`);
  }
}

function run(cmd, args) {
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
}

function assert(cond, msg) {
  if (!cond) throw new Error(`断言失败: ${msg}`);
}

async function waitForHealth() {
  const deadline = Date.now() + 60000;
  let lastErr = '未尝试';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.ok) {
        const body = await res.json();
        assert(body.status === 'ok', '健康响应应包含 status=ok');
        return;
      }
      lastErr = `HTTP ${res.status}`;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`等待健康检查超时: ${lastErr}`);
}

async function post(pathname, body) {
  const res = await fetch(`${BASE_URL}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function smoke() {
  await waitForHealth();
  process.stdout.write(`健康检查通过: ${BASE_URL}/health\n`);

  // 建立三副本演练
  let r = await post('/api/drills', { replicas: ['alpha', 'beta', 'gamma'] });
  assert(r.status === 201 && r.body.ok, `建立演练失败: ${JSON.stringify(r.body)}`);
  const id = r.body.id;
  const ev = (evt) => post(`/api/drills/${id}/events`, evt);

  // 非法计数跳跃 → 明确拒绝
  r = await ev({ type: 'add', replica: 'alpha', counter: 3, payload: 'jump', target: 'beta' });
  assert(r.status === 400 && /计数跳跃/.test(r.body.error), '计数跳跃应被拒绝');
  // 未知副本 → 明确拒绝
  r = await ev({ type: 'add', replica: 'delta', counter: 1, payload: 'x', target: 'beta' });
  assert(r.status === 400 && /未知副本/.test(r.body.error), '未知副本应被拒绝');

  // 正常新增并投递
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'entry-1', target: 'beta' });
  assert(r.status === 200 && r.body.ok, '新增 alpha:1 应被接受');
  // 同一标识载荷不一致 → 拒绝
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'tampered', target: 'beta' });
  assert(r.status === 400 && /载荷不一致/.test(r.body.error), '载荷不一致应被拒绝');
  // 同一消息重放 → 幂等接受且无第二份状态
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'entry-1', target: 'beta' });
  assert(r.status === 200 && r.body.event.replay === true, '重放应标记为 replay');
  assert(r.body.state.perReplica.beta.visible.length === 1, '重放后 beta 仍只有一条可见');

  // beta 删除（绑定其观察到的 alpha:1），投递给 gamma
  r = await ev({ type: 'delete', replica: 'beta', target: 'gamma' });
  assert(r.status === 200, '删除应被接受');
  assert(r.body.event.context.alpha === 1, '删除上下文应绑定观察到的新增点');

  // 乱序迟到的新增：被删除上下文覆盖 → 抑制；未被覆盖的 → 可见
  r = await ev({ type: 'add', replica: 'alpha', counter: 2, payload: 'entry-2', target: 'alpha' });
  assert(r.status === 200, '新增 alpha:2 应被接受');
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'entry-1', target: 'gamma' });
  assert(r.body.state.perReplica.gamma.visible.length === 0, '被删除覆盖的迟到新增不可见');
  r = await ev({ type: 'add', replica: 'alpha', counter: 2, payload: 'entry-2', target: 'gamma' });
  assert(r.body.state.perReplica.gamma.visible.length === 1, '未被覆盖的迟到新增应可见');

  // 未三方确认前压缩无效
  r = await ev({ type: 'ack', replica: 'alpha' });
  r = await ev({ type: 'ack', replica: 'beta' });
  r = await ev({ type: 'compact' });
  assert(r.body.event.compacted === 0, '缺少第三方确认时不得压缩');
  assert(r.body.state.perReplica.gamma.tombstones.length === 1, '墓碑应保留');

  // 第三方确认越过删除点后压缩成功
  r = await ev({ type: 'ack', replica: 'gamma' });
  r = await ev({ type: 'compact' });
  assert(r.body.event.compacted === 1, '三方确认后应压缩一个墓碑');
  assert(r.body.state.compactions.length === 1, '应产生压缩记录');
  assert(r.body.state.stableFrontier.alpha >= 1, '三方稳定前沿应越过删除点');
  assert(r.body.state.perReplica.gamma.tombstones.length === 0, '压缩后墓碑移除');

  // 压缩后迟到的旧新增被抑制：无可见条目、无新墓碑
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'entry-1', target: 'gamma' });
  assert(r.body.state.perReplica.gamma.visible.length === 1, '压缩后旧新增不得可见（仅剩 entry-2）');
  assert(r.body.state.perReplica.gamma.tombstones.length === 0, '压缩后旧新增不得产生新墓碑');
  assert(r.body.state.suppressed.some((s) => s.reason === 'compacted'), '应记录被压缩抑制的迟到消息');

  // 重开后重放已压缩的旧新增：仍不得生成可见条目或新墓碑
  r = await ev({ type: 'reopen', replica: 'gamma' });
  assert(r.status === 200, '重开应被接受');
  r = await ev({ type: 'add', replica: 'alpha', counter: 1, payload: 'entry-1', target: 'gamma' });
  assert(r.body.state.perReplica.gamma.visible.length === 1, '重开后重放仍不得可见');
  assert(r.body.state.perReplica.gamma.tombstones.length === 0, '重开后重放仍不得产生新墓碑');

  // 查询接口
  const res = await fetch(`${BASE_URL}/api/drills/${id}`);
  const snap = await res.json();
  assert(res.ok && snap.ok, '查询演练状态失败');
  assert(snap.rejected.length >= 3, '被拒绝事件应留有记录');
  process.stdout.write('冒烟场景全部断言通过\n');
}

(async () => {
  step('代码测试（node --test）', () => run(process.execPath, ['--test', 'test/']));
  step('构建检查（node --check）', () => {
    for (const f of ['src/crdt.js', 'src/server.js', 'scripts/verify.js']) {
      run(process.execPath, ['--check', f]);
    }
    // 模块可加载性检查
    run(process.execPath, ['-e', 'require("./src/crdt"); require("./src/server"); process.exit(0)']);
  });
  await astep(`API/HTTP 冒烟（${BASE_URL}）`, smoke);

  if (failures > 0) {
    process.stdout.write(`\n验收失败：${failures} 个步骤未通过\n`);
    process.exit(1);
  }
  process.stdout.write('\n验收通过：全部步骤成功\n');
  process.exit(0);
})();
