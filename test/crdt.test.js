'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDrill, applyEvent, snapshot, visibleEntries } = require('../src/crdt');

const R = ['alpha', 'beta', 'gamma'];

function drill() {
  return createDrill(R);
}

test('新增按递增计数接受，计数跳跃被明确拒绝且不污染演练', () => {
  const d = drill();
  assert.equal(applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' }).ok, true);
  const bad = applyEvent(d, { type: 'add', replica: 'alpha', counter: 5, payload: 'jump', target: 'beta' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /计数跳跃/);
  const s = snapshot(d);
  assert.equal(s.counters.alpha, 1); // 状态未被污染
  assert.equal(s.perReplica.beta.visible.length, 1);
  assert.equal(s.rejected.length, 1);
});

test('同一标识载荷不一致被拒绝，未知副本被拒绝', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  const conflict = applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'DIFFERENT', target: 'beta' });
  assert.equal(conflict.ok, false);
  assert.match(conflict.error, /载荷不一致/);
  const unknown = applyEvent(d, { type: 'add', replica: 'delta', counter: 1, payload: 'x', target: 'beta' });
  assert.equal(unknown.ok, false);
  assert.match(unknown.error, /未知副本/);
  const unknownTarget = applyEvent(d, { type: 'delete', replica: 'alpha', target: 'delta' });
  assert.equal(unknownTarget.ok, false);
  const unknownAck = applyEvent(d, { type: 'ack', replica: 'delta' });
  assert.equal(unknownAck.ok, false);
  const s = snapshot(d);
  assert.equal(s.perReplica.beta.visible.length, 1); // 仅最初一条
  assert.equal(s.rejected.length, 4);
});

test('同一消息重放不产生第二份状态（幂等）', () => {
  const d = drill();
  const evt = { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' };
  applyEvent(d, evt);
  const again = applyEvent(d, evt);
  assert.equal(again.ok, true);
  assert.equal(again.event.replay, true);
  const s = snapshot(d);
  assert.equal(s.perReplica.beta.visible.length, 1);
  assert.equal(s.perReplica.beta.knownDots.length, 1);
  assert.equal(s.perReplica.alpha.visible.length, 1);
});

test('乱序投递的旧新增仅在未被删除上下文覆盖时可见', () => {
  const d = drill();
  // alpha 产生两条，只把第一条投递给 beta
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'alpha' });
  // beta 删除：上下文只绑定它观察到的 alpha:1
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'gamma' });
  // 迟到的 alpha:1 投递到 gamma：被删除上下文覆盖 → 抑制
  const late1 = applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'gamma' });
  assert.equal(late1.ok, true);
  // 迟到的 alpha:2 投递到 gamma：未被删除上下文覆盖 → 可见
  const late2 = applyEvent(d, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'gamma' });
  assert.equal(late2.ok, true);
  const s = snapshot(d);
  const gammaVisible = s.perReplica.gamma.visible.map((e) => e.dot);
  assert.deepEqual(gammaVisible, ['alpha:2']);
  assert.equal(s.suppressed.filter((x) => x.reason === 'deleted').length, 1);
  assert.equal(s.perReplica.gamma.tombstones.length, 1); // 墓碑仍在
});

test('删除必须绑定当时观察到的新增点（上下文快照）', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'beta' });
  // 删除之后 beta 才观察到 alpha:2，删除上下文不应包含它
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'beta' });
  const s = snapshot(d);
  const tomb = s.perReplica.beta.tombstones[0];
  assert.deepEqual(tomb.context, { alpha: 1, beta: 0, gamma: 0 });
  assert.deepEqual(s.perReplica.beta.visible.map((e) => e.dot), ['alpha:2']);
});

test('只有三个副本都确认越过同一删除点后才能压缩', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'gamma' });
  // 仅两个副本确认
  applyEvent(d, { type: 'ack', replica: 'alpha' });
  applyEvent(d, { type: 'ack', replica: 'beta' });
  let r = applyEvent(d, { type: 'compact' });
  assert.equal(r.ok, true);
  assert.equal(r.event.compacted, 0);
  assert.equal(snapshot(d).perReplica.gamma.tombstones.length, 1); // 墓碑保留
  // 第三个副本确认越过删除点
  applyEvent(d, { type: 'ack', replica: 'gamma' });
  r = applyEvent(d, { type: 'compact' });
  assert.equal(r.event.compacted, 1);
  const s = snapshot(d);
  assert.equal(s.perReplica.gamma.tombstones.length, 0); // 墓碑被移除
  assert.equal(s.compactions.length, 1);
  assert.deepEqual(s.compactedFrontier, { alpha: 1, beta: 0, gamma: 0 });
  assert.deepEqual(s.stableFrontier, { alpha: 1, beta: 0, gamma: 0 }); // 三方稳定前沿
});

test('确认未越过删除点时不能压缩该墓碑', () => {
  const d2 = drill();
  applyEvent(d2, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'gamma' });
  applyEvent(d2, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'beta' });
  applyEvent(d2, { type: 'ack', replica: 'gamma' }); // gamma 确认 {alpha:1}
  applyEvent(d2, { type: 'delete', replica: 'beta', target: 'gamma' }); // 删除上下文 {alpha:2}
  applyEvent(d2, { type: 'ack', replica: 'alpha' });
  applyEvent(d2, { type: 'ack', replica: 'beta' });
  const r = applyEvent(d2, { type: 'compact' });
  assert.equal(r.event.compacted, 0); // gamma 的确认未越过 alpha:2
  assert.equal(snapshot(d2).perReplica.gamma.tombstones.length, 1);
});

test('压缩后迟到的旧新增被抑制：无可见条目、无新墓碑；重开后重放亦然', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'gamma' });
  applyEvent(d, { type: 'ack', replica: 'alpha' });
  applyEvent(d, { type: 'ack', replica: 'beta' });
  applyEvent(d, { type: 'ack', replica: 'gamma' });
  applyEvent(d, { type: 'compact' });
  assert.equal(snapshot(d).compactions.length, 1);

  // 压缩后，迟到的旧新增投递到 gamma
  const late = applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'gamma' });
  assert.equal(late.ok, true);
  let s = snapshot(d);
  assert.equal(s.perReplica.gamma.visible.length, 0);
  assert.equal(s.perReplica.gamma.tombstones.length, 0); // 不产生新墓碑
  assert.equal(s.perReplica.gamma.knownDots.length, 0); // 不落盘
  assert.equal(s.suppressed.filter((x) => x.reason === 'compacted').length, 1);

  // 重开后重放已压缩的旧新增：仍不得生成可见条目或新墓碑
  applyEvent(d, { type: 'reopen', replica: 'gamma' });
  const replay = applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'gamma' });
  assert.equal(replay.ok, true);
  s = snapshot(d);
  assert.equal(s.perReplica.gamma.visible.length, 0);
  assert.equal(s.perReplica.gamma.tombstones.length, 0);
  assert.equal(s.suppressed.filter((x) => x.reason === 'compacted').length, 2);
});

test('压缩后新新增（计数继续递增）不受影响', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'gamma' });
  for (const r of R) applyEvent(d, { type: 'ack', replica: r });
  applyEvent(d, { type: 'compact' });
  // 压缩覆盖 alpha:1；新条目 alpha:2 正常可见
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'gamma' });
  const s = snapshot(d);
  assert.deepEqual(s.perReplica.gamma.visible.map((e) => e.dot), ['alpha:2']);
});

test('重开保留未压缩的墓碑与可见状态', () => {
  const d = drill();
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 1, payload: 'e1', target: 'beta' });
  applyEvent(d, { type: 'add', replica: 'alpha', counter: 2, payload: 'e2', target: 'gamma' });
  applyEvent(d, { type: 'delete', replica: 'beta', target: 'gamma' }); // 覆盖 alpha:1
  applyEvent(d, { type: 'reopen', replica: 'gamma' });
  const s = snapshot(d);
  assert.equal(s.perReplica.gamma.tombstones.length, 1);
  assert.deepEqual(s.perReplica.gamma.visible.map((e) => e.dot), ['alpha:2']);
});

test('版本向量工具行为', () => {
  const { _vv } = require('../src/crdt');
  assert.equal(_vv.dominates({ a: 2, b: 1 }, { a: 1, b: 1 }), true);
  assert.equal(_vv.dominates({ a: 0 }, { a: 1 }), false);
  assert.deepEqual(_vv.mergeVV({ a: 1 }, { a: 2, b: 3 }), { a: 2, b: 3 });
  assert.deepEqual(_vv.minVV({ a: 2, b: 1 }, { a: 1, b: 5 }), { a: 1, b: 1 });
  assert.equal(_vv.coversDot({ a: 2 }, { replica: 'a', counter: 2 }), true);
  assert.equal(_vv.coversDot({ a: 2 }, { replica: 'a', counter: 3 }), false);
});
