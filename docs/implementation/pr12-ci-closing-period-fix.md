# PR12：隔离回归结转期间取样修复

2026-10-27（Asia/Shanghai）。开发修复证据，不代表发行包或生产验收。

## 托管失败与根因

- HEAD：`3c31be7402e0da7f123f30763f2a09bf298897d9`。
- [Linux CI 40443172766](https://github.com/osborn-studio/OS-ERP/actions/runs/40443172766)：focused、no-FTS5、Docker、浏览器通过；隔离回归 115 项中 114 项通过，唯一失败是 `test:test-guards.mjs`（392 条通过、2 条失败）。隔离回归内的 `node:test` 通过。capacity / dependency-review 按条件跳过。
- 在全新隔离库复现同样两条断言：测试写死 `2026-07` 已结转，实际已结转期间为 `2026-08`。对未结转的七月请求撤销，服务按幂等契约返回 200 / `replayed: true` / `本期未结转`，没有走到缺少理由的校验。
- `report-seed` 已按实际损益选择结转期间；遗留 HTTP 守卫仍依赖旧的固定月份。此次不改变业务幂等行为或灌数逻辑。

## 修复

- 从当前测试库选择未关账、关联 `posted` / `profit_carry` 凭证的真实期间；没有样本时明确失败，不跳过。
- 校验 HTTP 400 与 `REVERSE_REASON_REQUIRED`，避免其它 4xx（如已关账）冒充理由校验通过。
- 核对期间记录、凭证和分录完全不变。
- 失败汇总逐条加 `✗` 标记，使现有 CI 过滤器保留失败名称。仅输出断言名称，不新增凭据或数据库内容日志。

## 本机 Node 22 开发验证

osstack 0.22.1 有限任务 `task_2ece8912` 执行成功，十个命令均通过；这不代表托管 CI 已通过。

- 完整 `test-guards`：cosmetic 396/396、food 397/397、apparel 396/396。
- 完整 `test-closing`：三个行业各 109/109。以上共 1516 条断言通过、0 失败。
- file-header、data-paths、test-helper-shape 守卫通过。
- 负向验证：仅临时移除生产函数的理由拒绝条件，测试变为 392 通过 / 4 失败，四条新断言全部失败；验证后逐字恢复生产文件，最终 diff 不包含生产代码。
- 四条失败名称均能通过现有 CI 的尾部日志过滤。

## 独立复审与验收边界

Claude CLI `claude-haiku-5-5` 禁用工具，只审给定 diff、相关逻辑与验证证据。已核验 `is_error=false`、`canonicalModel=claude-haiku-5-5`；无确认的逻辑阻断，确认断言数及负向验证一致。

复审意见处理：

- 必须等待新 HEAD Linux CI；保留此验收条件。
- 若理由守卫失效，写账探针确实会删除测试凭证。代码注释已明确必须使用隔离库；此次所有运行均用 `/tmp/osstack/pr12-regression-fix/` 下新建的合成库，没有访问仓库 `data/` 或客户数据。
- 注释改为“让理由缺失成为唯一阻断条件”，避免混淆生产函数现有校验顺序。
- `✗` 的范围是断言失败汇总；缺夹具走 `Error` 和非零退出，现有 CI 过滤器也保留 `Error`，不声称缺夹具会进入断言汇总。

新提交必须重新运行 GitHub-hosted Linux CI，不能用本机结果或旧 HEAD 通过代替。此次不合并、不启用 auto-merge，也不恢复已取消的自动跟进。
