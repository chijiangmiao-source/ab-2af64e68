'use strict';

/**
 * 深空协作组离线探测清单 —— 核心领域逻辑（纯函数模块，不依赖 HTTP）。
 *
 * 模型：
 *  - 每个“新增”是一个点（dot）：{ replica, counter }，计数按副本严格递增。
 *  - “删除”绑定删除者在删除时刻观察到的全部新增点（上下文 = 其已知前沿的版本向量）。
 *  - 副本状态：已知点、已知前沿、墓碑（删除上下文）列表。
 *  - 同步确认（ack）：副本确认自己当前的前沿，用于三方稳定判定。
 *  - 压缩：仅当三个副本的确认都越过同一删除上下文时，墓碑才可移除，
 *    其上下文并入“已压缩前沿”；此后被该前沿覆盖的迟到新增一律被抑制，
 *    不产生可见条目，也不产生新墓碑。
 */

// ---------- 版本向量工具 ----------

function emptyVV(replicas) {
  const vv = {};
  for (const r of replicas) vv[r] = 0;
  return vv;
}

function mergeVV(a, b) {
  const out = { ...a };
  for (const k of Object.keys(b)) out[k] = Math.max(out[k] || 0, b[k]);
  return out;
}

/** a 是否逐分量 >= b（a 越过/覆盖 b） */
function dominates(a, b) {
  for (const k of Object.keys(b)) {
    if ((a[k] || 0) < b[k]) return false;
  }
  return true;
}

/** 版本向量是否覆盖某个点 */
function coversDot(vv, dot) {
  return (vv[dot.replica] || 0) >= dot.counter;
}

function minVV(a, b) {
  const out = {};
  for (const k of Object.keys(a)) out[k] = Math.min(a[k] || 0, b[k] || 0);
  return out;
}

function dotId(dot) {
  return `${dot.replica}:${dot.counter}`;
}

function parseDot(id) {
  const i = id.lastIndexOf(':');
  return { replica: id.slice(0, i), counter: Number(id.slice(i + 1)) };
}

// ---------- 演练（Drill） ----------

function createDrill(replicaNames) {
  if (!Array.isArray(replicaNames) || replicaNames.length !== 3) {
    throw new Error('演练必须恰好包含三个副本');
  }
  const names = replicaNames.map((n) => String(n).trim());
  if (names.some((n) => n.length === 0)) throw new Error('副本名不能为空');
  if (new Set(names).size !== 3) throw new Error('副本名必须互不相同');

  const states = {};
  const acks = {};
  for (const r of names) {
    states[r] = { dots: {}, frontier: emptyVV(names), tombstones: [] };
    acks[r] = emptyVV(names);
  }
  return {
    replicas: names,
    counters: emptyVV(names), // 各副本已产生（被演练接受）的最大计数
    messages: {},             // dotId -> payload，用于同一标识载荷一致性校验
    states,
    acks,                     // 各副本已确认的前沿
    compacted: emptyVV(names),// 已压缩前沿（压缩后用于抑制迟到新增）
    compactions: [],          // 压缩记录
    suppressed: [],           // 被抑制的迟到消息（证据）
    events: [],               // 已接受事件日志
    rejected: [],             // 被拒绝事件日志（不污染状态，仅作展示）
    seq: 0,
    tombstoneSeq: 0,
  };
}

function known(drill, name) {
  return drill.replicas.includes(name);
}

function reject(drill, type, error) {
  drill.rejected.push({ seq: ++drill.seq, type, error });
  return { ok: false, error };
}

function accept(drill, type, detail) {
  const evt = { seq: ++drill.seq, type, ...detail };
  drill.events.push(evt);
  return { ok: true, event: evt };
}

// ---------- 投递 ----------

/**
 * 把一个新增点投递到目标副本。返回投递结果标记。
 * 幂等：同一点重复投递不产生第二份状态。
 */
function deliver(drill, target, dot, payload) {
  const id = dotId(dot);
  // 已被压缩前沿覆盖：彻底抑制，不落盘、不产生墓碑
  if (coversDot(drill.compacted, dot)) {
    drill.suppressed.push({
      seq: ++drill.seq, dot: id, payload, target, reason: 'compacted',
      note: '被已压缩前沿覆盖的迟到新增，已抑制',
    });
    return 'suppressed-compacted';
  }
  const st = drill.states[target];
  if (Object.prototype.hasOwnProperty.call(st.dots, id)) {
    return 'duplicate'; // 同一消息重放：无第二份状态
  }
  st.dots[id] = payload;
  st.frontier[dot.replica] = Math.max(st.frontier[dot.replica] || 0, dot.counter);
  // 已被该副本已知的删除上下文覆盖：记录知识但不可见
  if (st.tombstones.some((t) => coversDot(t.context, dot))) {
    drill.suppressed.push({
      seq: ++drill.seq, dot: id, payload, target, reason: 'deleted',
      note: '被删除上下文覆盖的乱序旧新增，已抑制',
    });
    return 'suppressed-deleted';
  }
  return 'visible';
}

// ---------- 事件 ----------

/** 新增：{ replica, counter, payload, target } */
function addEvent(drill, { replica, counter, payload, target }) {
  if (!known(drill, replica)) return reject(drill, 'add', `未知副本: ${replica}`);
  if (!known(drill, target)) return reject(drill, 'add', `未知投递目标: ${target}`);
  if (!Number.isInteger(counter) || counter < 1) {
    return reject(drill, 'add', `非法计数: ${counter}`);
  }
  if (typeof payload !== 'string' || payload.length === 0) {
    return reject(drill, 'add', '载荷必须是非空字符串');
  }

  const dot = { replica, counter };
  const id = dotId(dot);
  const expected = drill.counters[replica] + 1;

  if (counter > expected) {
    return reject(drill, 'add',
      `非法计数跳跃: 副本 ${replica} 期望计数 ${expected}，收到 ${counter}`);
  }
  if (counter < expected) {
    // 旧消息重录：仅当载荷一致时按重放处理（幂等），否则明确拒绝
    const existing = drill.messages[id];
    if (existing === undefined) {
      return reject(drill, 'add', `计数 ${id} 已被压缩，无法校验载荷一致性`);
    }
    if (existing !== payload) {
      return reject(drill, 'add',
        `同一标识载荷不一致: ${id} 已记录为 ${JSON.stringify(existing)}，收到 ${JSON.stringify(payload)}`);
    }
    // 重放只是“再投递”：仅投向指定目标，不再触碰产生者
    const r = deliver(drill, target, dot, payload);
    return accept(drill, 'add', { dot: id, payload, target, replay: true, delivery: [r] });
  }

  // 正常递增：先校验完毕再落状态
  drill.messages[id] = payload;
  drill.counters[replica] = counter;
  const r1 = deliver(drill, replica, dot, payload); // 产生者本地可见
  const r2 = replica === target ? r1 : deliver(drill, target, dot, payload);
  return accept(drill, 'add', { dot: id, payload, target, replay: false, delivery: [r1, r2] });
}

/** 删除：{ replica, target } —— 上下文绑定 replica 当前观察到的新增点 */
function deleteEvent(drill, { replica, target }) {
  if (!known(drill, replica)) return reject(drill, 'delete', `未知副本: ${replica}`);
  if (!known(drill, target)) return reject(drill, 'delete', `未知投递目标: ${target}`);
  const context = { ...drill.states[replica].frontier };
  const id = `T${++drill.tombstoneSeq}`;
  const tombstone = { id, by: replica, context };
  const st = drill.states[target];
  if (!st.tombstones.some((t) => t.id === id)) st.tombstones.push(tombstone);
  st.frontier = mergeVV(st.frontier, context);
  return accept(drill, 'delete', { tombstone: id, by: replica, context, target });
}

/** 同步确认：{ replica } —— 确认自己当前的前沿（单调） */
function ackEvent(drill, { replica }) {
  if (!known(drill, replica)) return reject(drill, 'ack', `未知副本: ${replica}`);
  drill.acks[replica] = mergeVV(drill.acks[replica], drill.states[replica].frontier);
  return accept(drill, 'ack', { replica, acked: { ...drill.acks[replica] } });
}

/** 三方稳定前沿：三个副本确认前沿的逐分量最小值 */
function stableFrontier(drill) {
  return drill.replicas.reduce((acc, r) => minVV(acc, drill.acks[r]), { ...drill.acks[drill.replicas[0]] });
}

/** 压缩：仅当三个副本的确认都越过同一删除上下文时才移除该墓碑 */
function compactEvent(drill) {
  const stable = stableFrontier(drill);
  const removable = new Map(); // tombstoneId -> context
  for (const r of drill.replicas) {
    for (const t of drill.states[r].tombstones) {
      if (drill.replicas.every((x) => dominates(drill.acks[x], t.context))) {
        removable.set(t.id, t.context);
      }
    }
  }
  if (removable.size === 0) {
    return accept(drill, 'compact', { compacted: 0, stableFrontier: stable, note: '无满足三方确认的墓碑' });
  }
  // 已压缩前沿 = 旧前沿 与 所有被移除删除上下文 的归并
  let next = { ...drill.compacted };
  for (const ctx of removable.values()) next = mergeVV(next, ctx);
  drill.compacted = next;
  // 移除墓碑，并清除被已压缩前沿覆盖的存量点（被删数据随之物理清除）
  for (const r of drill.replicas) {
    const st = drill.states[r];
    st.tombstones = st.tombstones.filter((t) => !removable.has(t.id));
    for (const id of Object.keys(st.dots)) {
      if (coversDot(next, parseDot(id))) delete st.dots[id];
    }
  }
  const record = {
    seq: ++drill.seq,
    removedTombstones: [...removable.keys()],
    contexts: [...removable.values()],
    stableFrontier: stable,
    compactedFrontier: { ...next },
  };
  drill.compactions.push(record);
  return accept(drill, 'compact', {
    compacted: removable.size,
    stableFrontier: stable,
    compactedFrontier: { ...next },
    removedTombstones: record.removedTombstones,
  });
}

/** 重开：{ replica } —— 从持久化状态重新载入（已压缩前沿仍然生效） */
function reopenEvent(drill, { replica }) {
  if (!known(drill, replica)) return reject(drill, 'reopen', `未知副本: ${replica}`);
  const st = drill.states[replica];
  // 重启后加载持久化的压缩结果：清除被覆盖点、把已压缩前沿并入已知前沿
  for (const id of Object.keys(st.dots)) {
    if (coversDot(drill.compacted, parseDot(id))) delete st.dots[id];
  }
  st.frontier = mergeVV(st.frontier, drill.compacted);
  return accept(drill, 'reopen', { replica, frontier: { ...st.frontier } });
}

function applyEvent(drill, evt) {
  switch (evt.type) {
    case 'add': return addEvent(drill, evt);
    case 'delete': return deleteEvent(drill, evt);
    case 'ack': return ackEvent(drill, evt);
    case 'compact': return compactEvent(drill);
    case 'reopen': return reopenEvent(drill, evt);
    default: return reject(drill, evt.type || 'unknown', `未知事件类型: ${evt.type}`);
  }
}

// ---------- 视图 ----------

/** 副本当前可见条目：已知点中未被任何墓碑、也未被已压缩前沿覆盖者 */
function visibleEntries(drill, replica) {
  const st = drill.states[replica];
  const out = [];
  for (const [id, payload] of Object.entries(st.dots)) {
    const dot = parseDot(id);
    if (coversDot(drill.compacted, dot)) continue;
    if (st.tombstones.some((t) => coversDot(t.context, dot))) continue;
    out.push({ dot: id, payload });
  }
  out.sort((a, b) => a.dot.localeCompare(b.dot));
  return out;
}

function snapshot(drill) {
  const replicas = {};
  for (const r of drill.replicas) {
    const st = drill.states[r];
    replicas[r] = {
      visible: visibleEntries(drill, r),
      knownDots: Object.keys(st.dots).sort(),
      frontier: { ...st.frontier },
      acked: { ...drill.acks[r] },
      tombstones: st.tombstones.map((t) => ({ ...t, context: { ...t.context } })),
    };
  }
  return {
    replicas: drill.replicas,
    counters: { ...drill.counters },
    perReplica: replicas,
    stableFrontier: stableFrontier(drill),
    compactedFrontier: { ...drill.compacted },
    compactions: drill.compactions.map((c) => ({ ...c })),
    suppressed: drill.suppressed.map((s) => ({ ...s })),
    events: drill.events.map((e) => ({ ...e })),
    rejected: drill.rejected.map((e) => ({ ...e })),
  };
}

module.exports = {
  createDrill,
  applyEvent,
  snapshot,
  visibleEntries,
  stableFrontier,
  // 导出供测试
  _vv: { emptyVV, mergeVV, dominates, coversDot, minVV },
};
