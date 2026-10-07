# 深空协作组 · 离线探测清单演练

三副本离线清单的一致性演练工具：删除条目不会因迟到的旧新增消息在任一副本重新出现，同时删除墓碑无需无限保留——仅在三个副本都确认越过同一删除点后进行压缩，压缩后迟到的旧新增被彻底抑制。

## 一致性模型

- **新增**是一个点（dot）：`(副本, 计数)`，计数按副本严格递增（从 1 开始，每次 +1）。
- **删除**绑定删除者在删除时刻观察到的全部新增点（上下文 = 其已知前沿版本向量）。
- 乱序投递的旧新增：**未被删除上下文覆盖时可见**；被覆盖时被抑制（记录为证据，不产生可见条目）。
- **同一消息重放幂等**：同一点重复投递不产生第二份状态。
- 明确拒绝（且不污染演练状态）：非法计数跳跃、同一标识载荷不一致、未知副本/未知投递目标。
- **压缩**：仅当三个副本的同步确认都越过同一删除上下文时，对应墓碑被移除，其上下文并入“已压缩前沿”，被覆盖的存量数据物理清除。
- 压缩后（含**重开**之后）重放已压缩的旧新增：被已压缩前沿抑制——不产生可见条目，也不产生新墓碑。
- 页面展示**三方稳定前沿**（三方确认前沿的逐分量最小值）与**被抑制的迟到消息**作为证据。

## 运行（Compose）

```bash
# 启动 web（宿主端口可用 HOST_PORT 配置，默认 8080）
HOST_PORT=9000 docker compose up web

# 运行验收服务：代码测试 + 构建检查 + API/HTTP 冒烟，结束后以退出码报告结果
docker compose up --exit-code-from verify verify
echo $?   # 0 = 验收通过
```

- 健康响应：`GET /health` → `{"status":"ok", ...}`（Compose 中配置了对应 healthcheck）。
- 页面：`http://localhost:${HOST_PORT:-8080}/`

## 本地运行（无 Docker）

```bash
npm start                 # 启动 web（PORT 环境变量可改端口，默认 8080）
npm test                  # 仅单元测试
npm run verify            # 完整验收（需 web 已启动；BASE_URL 可指向远端）
```

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/health` | 健康响应 |
| POST | `/api/drills` | 建立演练：`{"replicas":["alpha","beta","gamma"]}`（可省略，默认三名） |
| GET | `/api/drills/:id` | 查看各副本可见条目、已知前沿、墓碑、压缩记录、三方稳定前沿、被抑制消息、事件日志 |
| POST | `/api/drills/:id/events` | 录入事件（见下） |

事件类型：

```json
{"type":"add","replica":"alpha","counter":1,"payload":"条目","target":"beta"}
{"type":"delete","replica":"beta","target":"gamma"}
{"type":"ack","replica":"gamma"}
{"type":"reopen","replica":"gamma"}
{"type":"compact"}
```

非法事件返回 `400` 与错误说明，且不会改变演练状态（仅在被拒绝事件日志中留痕）。

## 项目结构

```
src/crdt.js        核心领域逻辑（纯函数模块：点、版本向量、墓碑、压缩、抑制）
src/server.js      零依赖 HTTP 服务（API + 页面 + /health）
public/index.html  演练页面（建组、录事件、看状态与证据）
test/crdt.test.js  单元测试（迟到消息、幂等、拒绝、三方稳定压缩、重开重放）
scripts/verify.js  验收服务入口：测试 → 构建检查 → API/HTTP 冒烟 → 退出码
Dockerfile / docker-compose.yml
```
