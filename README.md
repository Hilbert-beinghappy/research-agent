# Pi Research Agent

Pi Research Agent（v2.0.0）是基于 [Pi Agent Harness](https://github.com/earendil-works/pi) 的本地优先、证据优先科研工作流。项目优先服务管理学与公共管理研究，同时提供社会学、政治学等可替换 Domain Package。

仓库保留 Pi 底层单仓库代码，科研能力集中在独立 Package 中。使用者从 Pi 对话终端进入科研工作流；开发者也可以通过只读 SDK 和 stdio RPC 检查多个研究项目。

## 从这里开始

| 入口 | 用途 |
| --- | --- |
| [科研 Agent 主包](packages/research-agent/README.md) | 产品能力、运行边界和完整发布检查 |
| [CLI、Skills 与 Tools](packages/research-agent/docs/cli.md) | 终端命令、11 个 Skills 和 14 个 governed aggregate Tools |
| [公共 API](packages/research-agent/docs/api.md) | Extension 与 Host 集成接口 |
| [项目格式](packages/research-agent/docs/project-format.md) | 文件化状态、记录模型、恢复与迁移 |
| [Adapter 开发](packages/research-agent/docs/adapter-development.md) | Source、Analysis Runtime 与 Artifact Adapter v1 |
| [SDK 与 stdio RPC](packages/research-agent/docs/sdk-rpc.md) | v2.0 多项目只读接口 |
| [v2.0 全流程示例](packages/research-agent/examples/full-workflow-v2.0/README.md) | 从终端到 SDK/RPC 的公开验收场景 |
| [v2.0 发布证据](packages/research-agent/docs/release-v2.0.md) | 能力、测试、性能和已知限制 |

## 架构边界

- Pi 核心运行框架尽量保持接近上游，科研代码不侵入 Pi 核心职责。
- packages/research-agent 承载科研工作流、Skills、Tools、Adapters、项目状态和评测。
- packages/research-agent-contracts 提供数据契约、JSON Schema 与协议类型，不执行网络或文件写入。
- Pi Session 保存对话和项目链接；科研项目文件保存可恢复、可复现的事实状态。
- 核心不要求数据库、自建托管 SaaS 或独立 Web UI；开放学术源和外部工具通过 Adapter 接入。

## v0.1–v2.0 能力

各版本均保留对应的评测、基准、迁移和发布证据。

| 版本 | 已实现能力 |
| --- | --- |
| v0.1 | 选题、检索、去重、全文状态、证据卡、引用核验、证据矩阵与文献综述 |
| v0.2 | 研究问题、概念与理论、假设或命题、检索协议、研究设计与预分析计划 |
| v0.3 | Python/R、可选 Stata、数据字典、定量分析、定性编码与案例比较 |
| v0.4 | 论断—证据映射、论文大纲与分段写作、完整性检查、同行评审和修订闭环 |
| v0.5 | Zotero、Obsidian、DOCX、PDF、XLSX、PPTX、研究记忆与持续文献监测 |
| v1.0 | Pi 终端全流程、格式迁移、恢复、权限、成本和回归评测 |
| v1.1 | 管理学、公共管理等 Domain Package 与合规数据源扩展 |
| v1.5 | 公共 Adapter 契约、macOS 强隔离注册、可移植交换包与文件式协作 |
| v2.0 | 多项目只读 SDK/stdio RPC、确定性模型路由、社区 Source Adapter 与可复现发布资格 |

## 仓库目录

```text
research-agent/
├── packages/
│   ├── research-agent/             # 科研 Agent 产品代码、Skills、Tools、Adapters、文档、示例与评测
│   ├── research-agent-contracts/   # 可分发的数据契约、协议类型与 JSON Schema
│   ├── agent/                      # Pi Agent 运行时
│   ├── ai/                         # Pi 多模型接口
│   ├── coding-agent/               # Pi 对话终端和 Extension Host
│   ├── tui/                        # Pi 终端 UI
│   └── ...                         # 其他保留的 Pi 底层包
├── .github/workflows/
│   └── research-agent.yml          # 科研 Agent 的 Ubuntu、macOS、Windows CI
├── pi-test.sh                      # 从源码启动 Pi
└── README.md                       # 当前项目首页
```

packages/agent、packages/ai、packages/coding-agent、packages/tui 等目录属于保留的 Pi 底层框架，不是科研能力主入口。

## 从源码快速启动

要求 Node.js 22.19.0 或更高。当前尚未发布公共 npm Package，以下方式直接从源码运行。

```sh
git clone https://github.com/Hilbert-beinghappy/research-agent.git
cd research-agent
npm ci --ignore-scripts

RESEARCH_AGENT_REPO="$(pwd)"
mkdir ../my-research-project
cd ../my-research-project

"$RESEARCH_AGENT_REPO/pi-test.sh" -e "$RESEARCH_AGENT_REPO/packages/research-agent"
```

### 最小交互流程

进入 Pi 对话终端后：

```text
/research-version
/research-init --domain public-administration "Public-sector AI accountability"
/skill:research-project-intake
```

接下来可以让 intake Skill 明确研究范围、概念和检索计划，再由 governed Tools 执行检索、全文处理、证据提交和引用核验。完整命令和工作流见 [CLI 文档](packages/research-agent/docs/cli.md)。

## 数据、证据与权限边界

- 研究项目事实保存在版本化 Markdown、JSON、RIS/BibTeX 和规范化项目记录中。
- 元数据、摘要、已获取全文、带页码或章节定位的证据、已核验引用是不同状态。
- 找不到全文、付费墙、元数据冲突、撤稿、引用未核实和证据不足不会被模型措辞改写成成功。
- Crossref、OpenAlex、Unpaywall、本地 PDF/RIS/BibTeX/CSL-JSON 和 Zotero 通过受控接口接入。
- Python 与 R 是主要可复现分析运行时；Stata 只检测并调用用户自有安装，不绑定或分发商业软件。
- 低风险本地读取、检索、分析和项目内新增产出按项目策略执行。
- 付费调用、敏感数据外传、外部写入、覆盖和删除必须经过明确确认。

成果可以生成 Markdown、JSON、RIS/BibTeX、Obsidian、DOCX、PDF、XLSX 和 PPTX；Adapter 失败不会改变规范化项目事实。

## 开发与验证

```sh
npm run check -w packages/research-agent-contracts
npm test -w packages/research-agent-contracts

npm run check -w packages/research-agent
npm run test:unit -w packages/research-agent
npm run test:integration -w packages/research-agent
npm run test:e2e -w packages/research-agent

npm run eval:v2.0 -w packages/research-agent -- v2.0
npm run qualify:release:v2.0 -w packages/research-agent
```

默认 CI 使用合成数据和录制事实，不需要模型凭据。真实模型评测属于显式授权的发布候选活动，仓库内只保留经过清理和哈希绑定的评测基线。

## Pi 上游关系与许可证

- 本仓库基于 Pi Agent Harness 进行二次开发，并保留上游底层代码及其归属。
- Pi 基线代码遵循根目录 [MIT License](LICENSE)。
- [Pi Research Agent](packages/research-agent/LICENSE) 与 [公共契约包](packages/research-agent-contracts/LICENSE) 遵循 Apache-2.0。
- 科研 Package 同时保留 NOTICE、第三方声明和 SBOM；许可证覆盖代码，不替代学术数据源、用户内容和授权数据库各自的使用条件。
